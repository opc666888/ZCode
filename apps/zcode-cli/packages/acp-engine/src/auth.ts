/**
 * Claude 账号授权（对话里完成，不打开任何浏览器）。
 *
 * 适配器 claude-agent-acp 在账号没登录时，session/prompt 返回 JSON-RPC -32000 "Authentication required"。
 * 它自带登录入口：`<适配器> --cli auth login --claudeai`，会打印一条授权链接并等待粘贴授权码
 * （纯管道即可，不需要终端；2026-11-20 实测）。本模块负责拉起这条命令、取出链接、把用户发来的授权码喂回去。
 *
 * 硬性安全要求（owner 2026-11-20）：账号只能在它自己对应的浏览器环境里登录，软件绝不能替用户打开浏览器。
 *   - 登录命令靠环境变量 BROWSER 决定用什么打开链接（缺省才调系统的 open）；这里把 BROWSER 指到一个什么都不做的程序。
 *   - 授权链接只作为文字交给用户，由用户自己复制到正确的浏览器环境。
 *   - 授权码、链接里的参数不进日志、不进错误信息。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { buildAgentEnv } from "./agent-process.js";
import type { AcpAgentConfig } from "./types.js";

/** ACP 规定的「需要授权」错误码。 */
export const AUTH_REQUIRED_CODE = -32000;

export function isAuthRequiredError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (code === AUTH_REQUIRED_CODE) return true;
  return typeof message === "string" && /authentication required/i.test(message);
}

/** 用户发来的这条消息像不像授权码（一整段、没有空白、够长）。 */
export function looksLikeAuthCode(text: string): boolean {
  return /^[A-Za-z0-9_\-#.~+/=]{16,512}$/.test(text.trim());
}

export function isCancelAuthText(text: string): boolean {
  return /^(取消|取消授权|不授权了|cancel)$/i.test(text.trim());
}

/** 一个什么都不做、立刻成功的程序，用来顶替「打开浏览器」。 */
export function noopBrowserCommand(platform: NodeJS.Platform = process.platform): string {
  // Windows 上 where.exe 收到一个参数只会查找并退出，不会打开任何东西；类 Unix 用 true。
  return platform === "win32" ? "where.exe" : "/usr/bin/true";
}

const ANSI_PATTERN = /\u001b\[[0-9;?]*[A-Za-z]|\u001b\]8;;[^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b\][^\u0007]*\u0007/g;

export function stripTerminalCodes(text: string): string {
  return text.replace(ANSI_PATTERN, "").replace(/\r/g, "");
}

/** 从登录命令的输出里取授权链接（只认 https）。 */
export function extractAuthUrl(output: string): string | undefined {
  const match = /https:\/\/[^\s"'<>]+/.exec(stripTerminalCodes(output));
  return match?.[0];
}

export interface AuthLoginResult {
  ok: boolean;
  /** 失败原因（白话，已去掉链接和可能的密钥片段）。 */
  reason?: string;
  /** 是连不上 Claude 官方服务器（而不是授权码有问题）。 */
  network?: boolean;
}

/** 登录命令的报错是不是「网络连不上」（授权码本身没问题，只是没送到官方服务器）。 */
export function isNetworkFailure(text: string): boolean {
  return /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|socket hang up|fetch failed|network|timed? ?out|certificate|self[- ]signed/i.test(
    text,
  );
}

/** 连不上官方服务器时给用户看的处理办法。 */
export const NETWORK_FAILURE_HINT =
  "连不上 Claude 官方服务器，授权码没能送出去（不是授权码的问题）。请先确认这台电脑的网络环境已经就绪；如果你是通过本机代理上网，到「设置 → HTTP 代理」填上代理地址，重启软件后再授权";

export interface AuthLoginOptions {
  /** 等授权链接出现的最长时间。 */
  urlTimeoutMs?: number;
  /** 提交授权码后等结果的最长时间。 */
  resultTimeoutMs?: number;
  /** 整个登录最多挂多久（用户迟迟不回授权码时自动放弃）。 */
  idleTimeoutMs?: number;
  spawnImpl?: typeof spawn;
  platform?: NodeJS.Platform;
  baseEnv?: NodeJS.ProcessEnv;
}

function safeReason(text: string): string {
  const cleaned = stripTerminalCodes(text)
    .replace(/https?:\/\/\S+/g, "<链接>")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !/^Opening browser|^If the browser|^Paste code/i.test(line));
  return cleaned.slice(-2).join("；").slice(0, 200);
}

/** 一次登录尝试：start() 拿到链接，submitCode() 交授权码，cancel() 放弃。 */
export class AuthLogin {
  private child: ChildProcess | undefined;
  private output = "";
  private exitCode: number | null | undefined;
  private exited: Promise<void> = Promise.resolve();
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private finished = false;

  constructor(
    private readonly agent: AcpAgentConfig,
    private readonly options: AuthLoginOptions = {},
  ) {}

  get isActive(): boolean {
    return !this.finished && this.child !== undefined && this.exitCode === undefined;
  }

  /** 拉起登录命令并等到授权链接；拿不到链接时抛出白话错误，进程已清理。 */
  async start(): Promise<string> {
    const platform = this.options.platform ?? process.platform;
    const env = buildAgentEnv(this.options.baseEnv ?? process.env, {
      ...this.agent.env,
      // 绝不让登录命令自己打开浏览器；NO_BROWSER 是给以后的版本留的双保险。
      BROWSER: noopBrowserCommand(platform),
      NO_BROWSER: "1",
    });
    const child = (this.options.spawnImpl ?? spawn)(
      this.agent.command,
      [...(this.agent.args ?? []), "--cli", "auth", "login", "--claudeai"],
      { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    this.child = child;
    const onData = (chunk: Buffer) => {
      this.output = (this.output + chunk.toString("utf8")).slice(-16_384);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.stdin?.on("error", () => {});
    this.exited = new Promise<void>((resolve) => {
      child.once("error", () => {
        this.exitCode ??= null;
        resolve();
      });
      child.once("exit", (code) => {
        this.exitCode = code;
        resolve();
      });
    });

    const deadline = Date.now() + (this.options.urlTimeoutMs ?? 30_000);
    while (Date.now() < deadline) {
      const url = extractAuthUrl(this.output);
      if (url && /paste code/i.test(stripTerminalCodes(this.output))) {
        this.idleTimer = setTimeout(() => void this.cancel(), this.options.idleTimeoutMs ?? 15 * 60_000);
        this.idleTimer.unref?.();
        return url;
      }
      if (this.exitCode !== undefined) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const reason = safeReason(this.output);
    await this.cancel();
    throw new Error(reason ? `没能生成授权链接：${reason}` : "没能生成授权链接，请稍后再试");
  }

  /** 把授权码交给登录命令，等它给出结果。 */
  async submitCode(code: string): Promise<AuthLoginResult> {
    const child = this.child;
    if (!child || this.exitCode !== undefined || this.finished)
      return { ok: false, reason: "这次授权已经结束，请重新发一条消息再授权" };
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const before = this.output.length;
    child.stdin?.write(`${code.trim()}\n`);
    const timeout = this.options.resultTimeoutMs ?? 90_000;
    const timedOut = await Promise.race([
      this.exited.then(() => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(true), timeout).unref?.()),
    ]);
    if (timedOut) {
      await this.cancel();
      return { ok: false, reason: "等授权结果超时了，可能是网络不通" };
    }
    this.finished = true;
    if (this.exitCode === 0) return { ok: true };
    const raw = stripTerminalCodes(this.output.slice(before));
    if (isNetworkFailure(raw)) return { ok: false, network: true, reason: NETWORK_FAILURE_HINT };
    return { ok: false, reason: safeReason(raw) || "授权码不对或已经过期" };
  }

  async cancel(): Promise<void> {
    this.finished = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const child = this.child;
    if (child && this.exitCode === undefined) {
      try {
        child.kill();
      } catch {
        // 已经退出
      }
      await Promise.race([this.exited, new Promise((resolve) => setTimeout(resolve, 2000))]);
    }
  }
}

/** 对话里给用户看的授权说明。链接单独成行，方便整条复制。 */
export function authInstructions(url: string): string {
  return [
    "> 软件提示（不是 Claude 的回答）：这台电脑上的 Claude 账号还没有登录。",
    "",
    "**需要先授权你的 Claude 账号**（只用做一次）",
    "",
    "1. 复制下面这条链接，粘贴到**这个账号对应的指纹浏览器环境**里打开。不要用电脑自带的浏览器，软件也不会替你打开。",
    "",
    "```",
    url,
    "```",
    "",
    "2. 在那个浏览器里登录并同意授权，页面会显示 **Authentication code**，点 **Copy code**。",
    "3. 回到这里，把授权码作为下一条消息直接发给我。",
    "",
    "授权成功后我会接着处理你刚才的问题。不想授权了就发「取消授权」。",
  ].join("\n");
}
