#!/usr/bin/env node
// 通过 Chrome DevTools Protocol 无焦点地操作隔离开发版的页面（不抢 owner 的鼠标键盘）。
// 前提：用 `run-desktop-isolated.sh start ... --remote-debugging-port=0` 启动（随机端口，只监听 127.0.0.1）。
// 用法：
//   node scripts/acp-dev/cdp.mjs targets                 # 列出页面
//   node scripts/acp-dev/cdp.mjs eval '<js 表达式>'       # 在主窗口页面里求值，打印结果
//   node scripts/acp-dev/cdp.mjs click-text '暂时跳过'    # 点击可见文本精确匹配的元素（按钮/链接/菜单项）
//   node scripts/acp-dev/cdp.mjs text                    # 打印主窗口可见文本（前 3000 字）
//   node scripts/acp-dev/cdp.mjs click-sel '<css>'       # 点击第一个可见的 CSS 选择器匹配元素
//   node scripts/acp-dev/cdp.mjs hover-text '<文本>'      # 虚拟鼠标悬停到该文本元素（显示悬停按钮，不动系统鼠标）
//   node scripts/acp-dev/cdp.mjs type '<文本>'          # 往当前聚焦的输入框插入文本（CDP Input.insertText，不经系统键盘）
//   node scripts/acp-dev/cdp.mjs key Enter|Escape        # 向页面派发按键（CDP Input.dispatchKeyEvent，不经系统键盘）
//   node scripts/acp-dev/cdp.mjs wait-text '<文本>' [秒]  # 等页面出现该文本（默认 30 秒）
//   node scripts/acp-dev/cdp.mjs shot <输出.png>          # 用 CDP 截当前页面（只有开发版页面内容，不会截到其他窗口）
// 以上全部经 CDP 发给开发版页面，不移动系统鼠标、不发系统按键、不抢前台焦点。
// 选页：默认取 url 含 index.html 的第一个页面，可用 ACP_CDP_TARGET=<url 片段> 指定。
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const devRoot = resolve(
  process.env.ACP_DEV_ROOT?.trim() || join(repoRoot, "..", "workspace-runtime", "tmp", "20261119-zcode-acp"),
);
const portFile = join(devRoot, "electron-userdata", "session", "DevToolsActivePort");
let port;
try {
  port = readFileSync(portFile, "utf8").split("\n")[0].trim();
} catch {
  console.error(`找不到 ${portFile}：请用 --remote-debugging-port=0 启动开发版`);
  process.exit(2);
}

const [cmd, arg] = process.argv.slice(2);
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
if (cmd === "targets") {
  for (const t of targets) console.log(`${t.type}\t${t.title}\t${t.url}`);
  process.exit(0);
}
const want = process.env.ACP_CDP_TARGET?.trim() || "index.html";
const page = targets.find((t) => t.type === "page" && t.url.includes(want)) ?? targets.find((t) => t.type === "page");
if (!page) {
  console.error("没有可用页面");
  process.exit(2);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
let nextId = 1;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
};
const send = (method, params = {}) =>
  new Promise((r) => {
    const id = nextId++;
    pending.set(id, r);
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => {
  const res = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (res.result?.exceptionDetails) throw new Error(JSON.stringify(res.result.exceptionDetails));
  return res.result?.result?.value;
};

try {
  if (cmd === "eval") {
    console.log(JSON.stringify(await evaluate(arg), null, 2));
  } else if (cmd === "text") {
    console.log(String(await evaluate("document.body.innerText")).slice(0, 3000));
  } else if (cmd === "click-text") {
    const result = await evaluate(`(() => {
      const want = ${JSON.stringify(arg)};
      const all = [...document.querySelectorAll('button, a, [role="button"], [role="menuitem"], [role="option"], [role="tab"], span, div')];
      const hit = all.find((el) => el.innerText?.trim() === want && el.offsetParent !== null);
      if (!hit) return "未找到：" + want;
      const target = hit.closest('button, a, [role="button"], [role="menuitem"], [role="option"], [role="tab"]') ?? hit;
      target.click();
      return "已点击：" + want + " <" + target.tagName.toLowerCase() + ">";
    })()`);
    console.log(result);
  } else if (cmd === "click-sel") {
    console.log(
      await evaluate(`(() => {
        const el = [...document.querySelectorAll(${JSON.stringify(arg)})].find((e) => e.offsetParent !== null || e.getClientRects().length);
        if (!el) return "未找到：" + ${JSON.stringify(arg)};
        el.scrollIntoView({ block: "center" });
        for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
          el.dispatchEvent(new (type.startsWith("pointer") ? PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true, button: 0 }));
        }
        el.click();
        return "已点击 <" + el.tagName.toLowerCase() + "> " + (el.innerText || el.getAttribute("aria-label") || "").trim().slice(0, 60);
      })()`),
    );
  } else if (cmd === "hover-text" || cmd === "mouse-text") {
    // 把 CDP 虚拟鼠标移到包含该文本的最后一个可见元素中心（触发 :hover / 悬停按钮），不动系统鼠标。
    const box = await evaluate(`(() => {
      const want = ${JSON.stringify(arg)};
      const hits = [...document.querySelectorAll('body *')].filter((el) => el.childElementCount === 0 && el.innerText?.trim() === want && el.offsetParent !== null);
      const el = hits[hits.length - 1];
      if (!el) return null;
      el.scrollIntoView({ block: "center" });
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    if (!box) throw new Error(`未找到：${arg}`);
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
    if (cmd === "mouse-text") {
      // 真实鼠标按下/抬起：下拉菜单这类只认 pointerdown 的控件，el.click() 打不开
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
    }
    console.log(cmd === "mouse-text" ? "已鼠标点击" : "已悬停", arg, JSON.stringify(box));
  } else if (cmd === "type") {
    await send("Input.insertText", { text: arg ?? "" });
    console.log("已输入", JSON.stringify(arg));
  } else if (cmd === "key") {
    const keys = { Enter: { code: "Enter", keyCode: 13, text: "\r" }, Escape: { code: "Escape", keyCode: 27 }, Backspace: { code: "Backspace", keyCode: 8 } };
    const k = keys[arg];
    if (!k) throw new Error(`不支持的按键 ${arg}`);
    const base = { key: arg, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode };
    await send("Input.dispatchKeyEvent", { type: "keyDown", ...base, ...(k.text ? { text: k.text } : {}) });
    await send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    console.log("已按键", arg);
  } else if (cmd === "wait-text") {
    const limit = Number(process.argv[4] ?? 30) * 1000;
    const until = Date.now() + limit;
    let ok = false;
    while (Date.now() < until) {
      if (await evaluate(`document.body.innerText.includes(${JSON.stringify(arg)})`)) {
        ok = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    console.log(ok ? `出现：${arg}` : `超时未出现：${arg}`);
    if (!ok) process.exitCode = 1;
  } else if (cmd === "shot") {
    if (!arg) throw new Error("shot 需要输出路径");
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const res = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    if (!res.result?.data) throw new Error(`截图失败 ${JSON.stringify(res.error ?? res)}`);
    mkdirSync(dirname(resolve(arg)), { recursive: true });
    writeFileSync(resolve(arg), Buffer.from(res.result.data, "base64"));
    console.log(resolve(arg));
  } else {
    console.error("用法：targets | eval <expr> | text | click-text <文本> | click-sel <css> | hover-text <文本> | mouse-text <文本> | type <文本> | key <键> | wait-text <文本> [秒] | shot <png>");
    process.exitCode = 2;
  }
} finally {
  ws.close();
}
