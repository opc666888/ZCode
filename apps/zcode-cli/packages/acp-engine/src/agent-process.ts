/**
 * 一个外部 ACP 智能体进程 + 一条 ACP 客户端连接（stdio / ndjson）。
 *
 * 所有者：每个 ZCode 会话一个 AgentProcess，由 engine.ts 的会话运行时持有。
 * 本文件只负责进程生命周期、initialize 握手和把入站请求/通知交给回调；
 * 回合语义（取消、权限、事件顺序）在 engine.ts。
 *
 * 安全：日志只出现智能体 id、退出码等元信息；env 的值从不进入日志或错误信息；
 * stderr 只保留末尾少量文本用于报错，并做令牌样式脱敏。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  client,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type ClientConnection,
} from "@agentclientprotocol/sdk/unstable";
import { readWorkspaceTextFile, WorkspaceFsError, writeWorkspaceTextFile } from "./client-fs.js";
import type { AcpAgentConfig } from "./types.js";

/** 声明给智能体的客户端能力：文件读写在 cwd 内实现；不提供终端；要子智能体完整正文。 */
export const CLIENT_CAPABILITIES = {
  fs: { readTextFile: true, writeTextFile: true },
  terminal: false,
  _meta: { "subagent-transcript": true },
} as const;

export interface AgentProcessHandlers {
  /** session/update 原始参数（未经 zod 结果改写）。 */
  onUpdate(params: unknown): void;
  /** session/request_permission 原始参数 → ACP RequestPermissionResponse。 */
  onPermission(
    params: unknown,
    signal: AbortSignal,
  ): Promise<{ outcome: { outcome: "cancelled" } | { outcome: "selected"; optionId: string } }>;
}

export interface AgentExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  spawnError?: string;
}

const STDERR_TAIL_BYTES = 2048;
const KILL_GRACE_MS = 1500;
const EXIT_INFO_WAIT_MS = 500;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref?.());
}

/** 把看起来像令牌的片段替换掉，避免 stderr 尾巴把密钥带进错误信息。 */
export function redactSecrets(text: string): string {
  return text
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/g, "$1 <redacted>")
    .replace(
      /(authorization|api[_-]?key|token|secret|password)(["']?\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi,
      "$1$2<redacted>",
    )
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "sk-<redacted>")
    .replace(/[A-Za-z0-9_+/=-]{40,}/g, "<redacted>");
}

export class AgentProcess {
  private readonly child: ChildProcess;
  private readonly connection: ClientConnection;
  private stderrTail = "";
  private exitInfo: AgentExitInfo | undefined;
  readonly exited: Promise<AgentExitInfo>;
  agentCapabilities: Record<string, unknown> = {};

  private constructor(
    readonly agent: AcpAgentConfig,
    readonly cwd: string,
    handlers: AgentProcessHandlers,
    private readonly log: (msg: string) => void,
  ) {
    this.child = spawn(agent.command, agent.args ?? [], {
      cwd,
      env: { ...process.env, ...agent.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.exited = new Promise<AgentExitInfo>((resolve) => {
      this.child.once("error", (error) => {
        this.exitInfo ??= {
          code: null,
          signal: null,
          spawnError: (error as NodeJS.ErrnoException).code ?? error.message,
        };
        resolve(this.exitInfo);
      });
      this.child.once("exit", (code, signal) => {
        this.exitInfo ??= { code, signal };
        resolve(this.exitInfo);
      });
    });
    // stderr 必须持续读走，否则管道写满会把智能体卡死。
    this.child.stderr?.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL_BYTES);
    });
    this.child.stdin?.on("error", () => {
      // 进程已退出时写 stdin 会 EPIPE；退出由 exited 统一处理。
    });

    const app = client({ name: "zcode-acp-engine" });
    app.onNotification(
      "session/update",
      (raw: unknown) => raw,
      ({ params }) => {
        handlers.onUpdate(params);
      },
    );
    app.onRequest(
      "session/request_permission",
      (raw: unknown) => raw,
      ({ params, signal }) => handlers.onPermission(params, signal),
    );
    app.onRequest(
      "fs/read_text_file",
      (raw: unknown) => (raw ?? {}) as Record<string, unknown>,
      async ({ params }) => {
        try {
          return await readWorkspaceTextFile(this.cwd, params);
        } catch (error) {
          throw toRequestError(error);
        }
      },
    );
    app.onRequest(
      "fs/write_text_file",
      (raw: unknown) => (raw ?? {}) as Record<string, unknown>,
      async ({ params }) => {
        try {
          return await writeWorkspaceTextFile(this.cwd, params);
        } catch (error) {
          throw toRequestError(error);
        }
      },
    );

    const stdin = this.child.stdin
      ? (Writable.toWeb(this.child.stdin) as WritableStream<Uint8Array>)
      : new WritableStream<Uint8Array>();
    const stdout = this.child.stdout
      ? (Readable.toWeb(this.child.stdout) as ReadableStream<Uint8Array>)
      : new ReadableStream<Uint8Array>();
    this.connection = app.connect(ndJsonStream(stdin, stdout));
    void this.exited.then(() => this.connection.close());
  }

  /** 启动进程并完成 initialize；失败时进程已被清理。 */
  static async start(
    agent: AcpAgentConfig,
    cwd: string,
    handlers: AgentProcessHandlers,
    log: (msg: string) => void,
    signal: AbortSignal,
  ): Promise<AgentProcess> {
    const proc = new AgentProcess(agent, cwd, handlers, log);
    log(`[acp-engine] 启动智能体 ${agent.id}（pid ${proc.child.pid ?? "?"}）`);
    try {
      const response = await proc.raceExit(
        proc.connection.agent.request("initialize", {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: CLIENT_CAPABILITIES,
          clientInfo: { name: "zcode", version: "acp-engine/0.1.0" },
        }),
        signal,
      );
      const caps = (response as { agentCapabilities?: unknown }).agentCapabilities;
      proc.agentCapabilities =
        caps && typeof caps === "object" ? (caps as Record<string, unknown>) : {};
      return proc;
    } catch (error) {
      await proc.kill();
      throw error;
    }
  }

  get supportsLoadSession(): boolean {
    return this.agentCapabilities.loadSession === true;
  }

  get isAlive(): boolean {
    return this.exitInfo === undefined && !this.connection.signal.aborted;
  }

  /** 进程退出的可读说明（不含 env；stderr 尾巴已脱敏）。 */
  describeExit(): string {
    const info = this.exitInfo;
    const head = !info
      ? "ACP 连接已断开"
      : info.spawnError
        ? `无法启动 ACP 智能体「${this.agent.id}」：${info.spawnError}`
        : `ACP 智能体「${this.agent.id}」进程已退出（code=${info.code ?? "null"}${info.signal ? `，signal=${info.signal}` : ""}）`;
    const tail = redactSecrets(this.stderrTail.trim()).split("\n").slice(-5).join("\n");
    return tail ? `${head}\n${tail}` : head;
  }

  /** 发请求，并在进程退出 / signal 中止时尽快失败。 */
  request<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T> {
    return this.raceExit(this.connection.agent.request<T>(method, params), signal);
  }

  notify(method: string, params: unknown): Promise<void> {
    return this.connection.agent.notify(method, params).catch((error: unknown) => {
      this.log(`[acp-engine] 通知 ${method} 发送失败：${(error as Error).message}`);
    });
  }

  private raceExit<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        fn();
      };
      const onAbort = () => finish(() => reject(new AbortedError()));
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      promise.then(
        (value) => finish(() => resolve(value)),
        (error: unknown) => {
          // 进程崩溃时 stdout 先关闭、exit 事件稍后才到：短暂等一下退出信息，报错才能带上退出码。
          void Promise.race([this.exited, delay(EXIT_INFO_WAIT_MS)]).then(() =>
            finish(() => reject(this.exitInfo ? new AgentExitedError(this.describeExit()) : error)),
          );
        },
      );
      void this.exited.then(() => finish(() => reject(new AgentExitedError(this.describeExit()))));
    });
  }

  /** 关闭连接并结束进程：先关 stdin + SIGTERM，宽限期后 SIGKILL。 */
  async kill(): Promise<void> {
    this.connection.close();
    if (this.exitInfo) return;
    this.child.stdin?.end();
    this.child.kill("SIGTERM");
    const timer = setTimeout(() => {
      if (!this.exitInfo) this.child.kill("SIGKILL");
    }, KILL_GRACE_MS);
    timer.unref?.();
    await this.exited;
    clearTimeout(timer);
  }
}

export class AbortedError extends Error {
  constructor() {
    super("aborted");
  }
}

export class AgentExitedError extends Error {}

function toRequestError(error: unknown): Error {
  if (error instanceof WorkspaceFsError)
    return RequestError.invalidParams(undefined, error.message);
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT") return RequestError.resourceNotFound();
  return RequestError.internalError(undefined, code ?? "文件操作失败");
}
