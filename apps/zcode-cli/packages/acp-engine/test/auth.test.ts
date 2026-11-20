/**
 * Claude 账号授权：对话里给链接、收授权码，不打开浏览器（owner 2026-11-20 硬要求）。
 * 用假登录命令（fake-login.mjs）和假智能体的 needauth 剧本，不联网、不碰任何真实账号。
 */
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AuthLogin,
  authInstructions,
  extractAuthUrl,
  isAuthRequiredError,
  isCancelAuthText,
  looksLikeAuthCode,
  noopBrowserCommand,
} from "../src/auth.js";
import { createAcpEngineWithOptions } from "../src/engine.js";
import type { AcpAgentConfig, AcpEngine, EngineEvent } from "../src/types.js";
import { FAKE_AGENT, makeTempDir, removeDir } from "./helpers.js";

const FAKE_LOGIN = join(dirname(fileURLToPath(import.meta.url)), "fake-login.mjs");
const GOOD_CODE = "GOOD-CODE-1234567890#state";

describe("授权工具函数", () => {
  it("识别「需要授权」错误：按错误码或文字", () => {
    expect(isAuthRequiredError({ code: -32000, message: "x" })).toBe(true);
    expect(isAuthRequiredError(new Error("Authentication required"))).toBe(true);
    expect(isAuthRequiredError(new Error("rate limited"))).toBe(false);
    expect(isAuthRequiredError(undefined)).toBe(false);
  });

  it("授权码和取消的判断", () => {
    expect(looksLikeAuthCode("  69ZvKR1XzIxZ1KGqlxRfVafFr68RTHwims7k#-12gFCeBNGzvUo1  ")).toBe(true);
    expect(looksLikeAuthCode("帮我看看这个文件")).toBe(false);
    expect(looksLikeAuthCode("abc def ghi jkl mno pqr")).toBe(false);
    expect(looksLikeAuthCode("short")).toBe(false);
    expect(isCancelAuthText("取消授权")).toBe(true);
    expect(isCancelAuthText(" 取消 ")).toBe(true);
    expect(isCancelAuthText("取消订单怎么写")).toBe(false);
  });

  it("从带终端控制符的输出里取链接；说明里写明去指纹浏览器、不替用户打开", () => {
    const out = "Opening…\nvisit: \u001b]8;;https://a.example/x?s=1\u0007https://a.example/x?s=1\u001b]8;;\u0007\nPaste";
    expect(extractAuthUrl(out)).toBe("https://a.example/x?s=1");
    expect(extractAuthUrl("no link here")).toBeUndefined();
    const text = authInstructions("https://a.example/x?s=1");
    expect(text).toContain("https://a.example/x?s=1");
    expect(text).toMatch(/这个账号对应的指纹浏览器环境/);
    expect(text).toMatch(/软件也不会替你打开/);
    expect(text).toMatch(/取消授权/);
  });

  it("顶替浏览器的空程序：类 Unix 用 true，Windows 用 where.exe", () => {
    expect(noopBrowserCommand("darwin")).toBe("/usr/bin/true");
    expect(noopBrowserCommand("linux")).toBe("/usr/bin/true");
    expect(noopBrowserCommand("win32")).toBe("where.exe");
  });
});

describe("AuthLogin × 假登录命令", () => {
  let base: string;
  let agent: AcpAgentConfig;
  beforeEach(async () => {
    base = await makeTempDir("auth");
    agent = {
      id: "fake",
      name: "Fake",
      command: process.execPath,
      args: [FAKE_LOGIN],
      env: { FAKE_LOGIN_LOG: join(base, "login.log"), FAKE_LOGIN_MARK: join(base, "logged-in") },
    };
  });
  afterEach(async () => {
    await removeDir(base);
  });

  it("给出链接；登录命令的 BROWSER 被指到空程序、带登录参数；正确的码成功", async () => {
    const login = new AuthLogin(agent);
    const url = await login.start();
    expect(url).toBe("https://claude.example/oauth/authorize?code=true&state=SECRET-STATE");
    expect(login.isActive).toBe(true);
    const seen = JSON.parse((await readFile(join(base, "login.log"), "utf8")).trim());
    expect(seen.args).toEqual(["--cli", "auth", "login", "--claudeai"]);
    expect(seen.browser).toBe(noopBrowserCommand());
    expect(seen.noBrowser).toBe("1");
    expect(await login.submitCode(`  ${GOOD_CODE}\n`)).toEqual({ ok: true });
    expect(existsSync(join(base, "logged-in"))).toBe(true);
    expect(login.isActive).toBe(false);
  });

  it("错的码：失败并给出原因，原因里没有链接和授权码", async () => {
    const login = new AuthLogin(agent);
    await login.start();
    const result = await login.submitCode("WRONG-CODE-1234567890");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/invalid authorization code/);
    expect(result.reason).not.toMatch(/SECRET-STATE|WRONG-CODE/);
    expect(existsSync(join(base, "logged-in"))).toBe(false);
  });

  it("生成不了链接：抛白话错误；取消后再提交码按已结束处理", async () => {
    const broken = new AuthLogin({ ...agent, env: { ...agent.env, FAKE_LOGIN_NO_URL: "1" } });
    await expect(broken.start()).rejects.toThrow(/没能生成授权链接.*network unreachable/);
    const login = new AuthLogin(agent);
    await login.start();
    await login.cancel();
    expect(login.isActive).toBe(false);
    expect((await login.submitCode(GOOD_CODE)).ok).toBe(false);
  });
});

describe("引擎里的授权对话", () => {
  let base: string;
  let cwd: string;
  let agent: AcpAgentConfig;
  let engine: AcpEngine;
  const logs: string[] = [];

  beforeEach(async () => {
    base = await makeTempDir("auth-engine");
    cwd = join(base, "work");
    await mkdir(cwd, { recursive: true });
    const marker = join(base, "logged-in");
    agent = {
      id: "fake",
      name: "Fake",
      command: process.execPath,
      args: [FAKE_AGENT],
      env: { FAKE_AGENT_LOG: join(base, "agent.log"), FAKE_AGENT_AUTH_FILE: marker },
    };
    logs.length = 0;
    engine = createAcpEngineWithOptions({
      stateDir: join(base, "state"),
      log: (m) => logs.push(m),
      createAuthLogin: () =>
        new AuthLogin({
          id: "fake",
          name: "Fake",
          command: process.execPath,
          args: [FAKE_LOGIN],
          env: { FAKE_LOGIN_MARK: marker },
        }),
    });
  });
  afterEach(async () => {
    await engine.dispose();
    await removeDir(base);
  });

  async function say(prompt: string) {
    const events: EngineEvent[] = [];
    const result = await engine.runTurn(
      { zcodeSessionId: "z-auth", cwd, agent, prompt, signal: new AbortController().signal },
      {
        emit: (ev) => void events.push(ev),
        requestPermission: async () => ({ outcome: "cancelled" }) as never,
      },
    );
    const text = events
      .filter((ev): ev is Extract<EngineEvent, { kind: "text" }> => ev.kind === "text")
      .map((ev) => ev.delta)
      .join("");
    return { result, text };
  }

  it("没登录 → 给链接 → 闲聊提醒 → 错码重给链接 → 对的码授权成功并接着回答原问题", async () => {
    const first = await say("needauth 帮我看看项目");
    expect(first.result.stopReason).toBe("end_turn");
    expect(first.text).toContain("https://claude.example/oauth/authorize?code=true&state=SECRET-STATE");
    expect(first.text).toMatch(/这个账号对应的指纹浏览器环境/);

    const chat = await say("这是什么意思啊");
    expect(chat.result.stopReason).toBe("end_turn");
    expect(chat.text).toMatch(/我还在等授权码/);

    const wrong = await say("WRONG-CODE-1234567890");
    expect(wrong.result.stopReason).toBe("end_turn");
    expect(wrong.text).toMatch(/授权没有成功/);
    expect(wrong.text).toContain("https://claude.example/oauth/authorize");

    const good = await say(GOOD_CODE);
    expect(good.result.stopReason).toBe("end_turn");
    expect(good.text).toMatch(/授权成功/);
    expect(good.text).toContain("echo:needauth 帮我看看项目");

    const after = await say("needauth 再来一条");
    expect(after.text).toBe("echo:needauth 再来一条");
    // 授权码和链接参数不进引擎日志
    expect(logs.join("\n")).not.toMatch(/GOOD-CODE|WRONG-CODE|SECRET-STATE/);
  });

  it("发「取消授权」就放弃；之后再发消息重新给链接", async () => {
    await say("needauth 你好");
    const cancelled = await say("取消授权");
    expect(cancelled.text).toMatch(/已取消授权/);
    const again = await say("needauth 你好");
    expect(again.text).toContain("https://claude.example/oauth/authorize");
  });
});
