// ACP 开发版桌面的隔离护栏，经 NODE_OPTIONS=--require 在 Electron 主进程最先加载。
// 目的：开发版与本机正式版 ZCode（/Applications/ZCode.app）并排运行时，不碰任何全机共享的东西。
//   1. 不抢 zcode:// 默认协议处理器（上游 main 会无条件调 app.setAsDefaultProtocolClient("zcode")，
//      macOS 上这会改 LaunchServices 的全机默认处理器，把正式版的 OAuth/分享回调抢走）。
//   2. 不碰登录钥匙串（Chromium --use-mock-keychain，cookie/safeStorage 用内存假钥匙串）。
//   3. 不注册登录项。
//   4. 启动后核对 app name / userData / home / sessionData 都在隔离根下，否则立刻退出（fail-closed）。
// 只在 Electron 主进程（process.type === "browser"）生效；其他进程（Host utility、Agent CLI、插件）直接跳过，
// 并把自己从 NODE_OPTIONS 里摘掉，避免继续向子进程扩散。
"use strict";

if (process.type === "browser") {
  // 摘掉 NODE_OPTIONS 里的本护栏，后续 spawn 的子进程不再加载它。
  if (process.env.NODE_OPTIONS) {
    process.env.NODE_OPTIONS = process.env.NODE_OPTIONS.split(/\s+/)
      .filter((part, index, all) => {
        if (part.includes("electron-isolation-guard")) return false;
        if (part === "--require" && all[index + 1]?.includes("electron-isolation-guard")) return false;
        return true;
      })
      .join(" ")
      .trim();
    if (!process.env.NODE_OPTIONS) delete process.env.NODE_OPTIONS;
  }

  // --require 预加载早于 Electron 注册内置 electron 模块（此时 require 只拿到 npm 包的路径字符串）；
  // 实测 process.nextTick 时已可用，且早于 main（ESM）的顶层代码执行。
  process.nextTick(installGuard);
}

function installGuard() {
  const path = require("node:path");
  const electron = require("electron");
  const tag = "[acp-dev isolation]";
  const isolationRoot = process.env.ACP_DEV_ROOT ? path.resolve(process.env.ACP_DEV_ROOT) : "";
  if (typeof electron !== "object" || !electron.app) {
    console.error(`${tag} 无法取得 electron.app，拒绝启动`);
    process.exit(3);
  }
  const { app } = electron;
  if (!isolationRoot) {
    console.error(`${tag} 缺少 ACP_DEV_ROOT，拒绝启动`);
    app.exit(3);
    return;
  }

  // 在 main 求值前先把身份与数据目录指到隔离位置（main 随后会用同样的环境变量再设一次）。
  // Electron 默认按 package.json productName（"ZCode"）推 userData，正好是正式版目录，所以这里不留空档。
  if (process.env.ZCODE_DESKTOP_APPLICATION_NAME) app.setName(process.env.ZCODE_DESKTOP_APPLICATION_NAME);
  if (process.env.ZCODE_DESKTOP_USER_DATA_DIR) {
    app.setPath("userData", process.env.ZCODE_DESKTOP_USER_DATA_DIR);
    app.setPath("sessionData", path.join(process.env.ZCODE_DESKTOP_USER_DATA_DIR, "session"));
  }
  if (process.env.ZCODE_DESKTOP_HOME_DIR) app.setPath("home", process.env.ZCODE_DESKTOP_HOME_DIR);
  // app.getPath("temp") 走 NSTemporaryDirectory，不认 TMPDIR；显式指到隔离 tmp（owner 规则：不写系统临时目录）。
  if (process.env.TMPDIR) app.setPath("temp", process.env.TMPDIR);
  app.setAppLogsPath(path.join(isolationRoot, "logs", "electron"));

  // PID 文件：经 open（LaunchServices）启动时拿不到子进程 PID，由主进程自己登记，run-desktop-isolated.sh stop 用它关闭。
  const fs = require("node:fs");
  const pidFile = path.join(isolationRoot, "logs", "desktop.pid");
  try {
    fs.mkdirSync(path.dirname(pidFile), { recursive: true });
    fs.writeFileSync(pidFile, `${process.pid}\n`);
  } catch (error) {
    console.error(`${tag} 写 PID 文件失败：${error.message}`);
  }
  app.once("quit", () => {
    try {
      if (fs.readFileSync(pidFile, "utf8").trim() === String(process.pid)) fs.unlinkSync(pidFile);
    } catch {}
  });

  app.commandLine.appendSwitch("use-mock-keychain");

  const noop = (name, ret) =>
    function patched(...args) {
      console.log(`${tag} 已拦截 app.${name}(${args.map((a) => JSON.stringify(a)).join(", ")})`);
      return ret;
    };
  app.setAsDefaultProtocolClient = noop("setAsDefaultProtocolClient", true);
  app.removeAsDefaultProtocolClient = noop("removeAsDefaultProtocolClient", true);
  app.setLoginItemSettings = noop("setLoginItemSettings", undefined);

  // GUI 验证用（可选）：ACP_DEV_AUTO_SELECT_DIR=<隔离根内的目录> 时，「打开文件夹」类原生对话框不弹出，
  // 直接返回该目录。这样选项目不需要操作系统级的键盘鼠标（不会误点到 owner 的其他窗口）。
  // 只接受隔离根内的路径；文件选择对话框照常弹（不在此拦截）。
  const autoDir = process.env.ACP_DEV_AUTO_SELECT_DIR ? path.resolve(process.env.ACP_DEV_AUTO_SELECT_DIR) : "";
  if (autoDir) {
    const insideRoot = (() => {
      const rel = path.relative(isolationRoot, autoDir);
      return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
    })();
    if (!insideRoot) {
      console.error(`${tag} ACP_DEV_AUTO_SELECT_DIR 不在隔离根内，忽略：${autoDir}`);
    } else {
      const { dialog } = electron;
      const original = dialog.showOpenDialog.bind(dialog);
      dialog.showOpenDialog = async (...args) => {
        const opts = args.find((a) => a && typeof a === "object" && Array.isArray(a.properties)) ?? {};
        if ((opts.properties ?? []).includes("openDirectory")) {
          console.log(`${tag} 已拦截目录选择对话框 → ${autoDir}`);
          return { canceled: false, filePaths: [autoDir] };
        }
        return original(...args);
      };
    }
  }

  const inside = (p) => {
    const rel = path.relative(isolationRoot, path.resolve(p));
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  };

  // 用 ready：main 是 ESM，异步求值，will-finish-launching 可能早于它的 setPath。护栏最先注册，ready 时最先执行。
  app.once("ready", () => {
    // userData/home/sessionData 由 main 在模块求值期 setPath，ready 时已生效。
    const report = {
      appName: app.getName(),
      userData: app.getPath("userData"),
      sessionData: app.getPath("sessionData"),
      home: app.getPath("home"),
      temp: app.getPath("temp"),
      ZCODE_DATA_BASE_DIR: process.env.ZCODE_DATA_BASE_DIR,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
    };
    console.log(`${tag} 实际路径 ${JSON.stringify(report, null, 2)}`);
    const problems = [];
    if (report.appName === "ZCode" || report.appName === "ZCode Preview") problems.push("app name 与正式版相同");
    for (const key of ["userData", "sessionData", "home", "ZCODE_DATA_BASE_DIR", "HOME"]) {
      if (!report[key] || !inside(report[key])) problems.push(`${key} 不在隔离根 ${isolationRoot} 下`);
    }
    if (problems.length) {
      console.error(`${tag} 隔离核验失败，立即退出：${problems.join("；")}`);
      app.exit(3);
      return;
    }
    console.log(`${tag} 隔离核验通过（隔离根 ${isolationRoot}）`);
  });
}
