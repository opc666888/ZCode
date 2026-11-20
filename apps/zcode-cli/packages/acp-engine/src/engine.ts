/**
 * AcpEngine 实现：每个 ZCode 会话一条 ACP 连接，首轮懒启动，进程退出后下一轮 initialize + session/load 恢复。
 *
 * 回合内事件顺序（单一所有者 = 本会话的 ActiveTurn）：
 *
 *   runTurn ─ ensureConnection(initialize) ─ ensureSession(load|new) ─ set_config_option(model)?
 *           ─ session/prompt ──────────────── 期间 session/update → mapSessionUpdate → emit 链（串行、保序）
 *                         └─ request_permission → 先排空 emit 链 → host.requestPermission → 回 optionId / cancelled
 *           ─ prompt 返回 → 让出一个宏任务（SDK 通知处理是异步的，响应可能先到）→ 排空 emit 链 → usage → TurnResult
 *
 * 取消：signal 触发 → 未决权限一律回 cancelled → 发 session/cancel → 最多等 cancelTimeoutMs（默认 5 秒），
 *       超时杀进程（下一轮按崩溃恢复）。session/load 期间智能体回放的历史 update 不转发给宿主。
 */
import type {
  AcpAgentConfig,
  AcpEngine,
  CreateAcpEngineOptions,
  EngineEvent,
  PermissionDecision,
  TurnHost,
  TurnInput,
  TurnResult,
} from "./types.js";
import { AbortedError, AgentExitedError, AgentProcess } from "./agent-process.js";
import { SessionStore } from "./session-store.js";
import {
  createToolCallMemory,
  mapPermissionRequest,
  mapSessionUpdate,
  mapStopReason,
  promptUsageEvent,
  type ToolCallMemory,
} from "./update-mapping.js";
import {
  AuthLogin,
  authInstructions,
  isAuthRequiredError,
  isCancelAuthText,
  looksLikeAuthCode,
} from "./auth.js";
import { modelOptionsFromConfigOptions, writeModelCache } from "./models.js";

export const DEFAULT_CANCEL_TIMEOUT_MS = 5000;

export interface AcpEngineInternalOptions extends CreateAcpEngineOptions {
  /** 取消后等待智能体回 cancelled 的上限，默认 5000ms（测试可调小）。 */
  cancelTimeoutMs?: number;
  /** 授权登录的实现（测试注入假的登录命令）。 */
  createAuthLogin?: (agent: AcpAgentConfig) => AuthLogin;
}

type PermissionOutcome = {
  outcome: { outcome: "cancelled" } | { outcome: "selected"; optionId: string };
};

class ActiveTurn {
  readonly memory: ToolCallMemory = createToolCallMemory();
  private chain: Promise<void> = Promise.resolve();
  private readonly textParts: string[] = [];
  private readonly toolIds = new Set<string>();
  private readonly pendingPermissions = new Set<() => void>();
  /** session/load 回放历史期间为 true：回放内容不是本回合的产出。 */
  replaying = false;

  constructor(
    readonly host: TurnHost,
    readonly signal: AbortSignal,
    private readonly log: (msg: string) => void,
  ) {}

  emit(event: EngineEvent): void {
    if (event.kind === "text" && !event.parentToolCallId) this.textParts.push(event.delta);
    if (event.kind === "tool_start") this.toolIds.add(event.toolCallId);
    this.chain = this.chain
      .then(() => this.host.emit(event))
      .then(undefined, (error: unknown) => {
        this.log(`[acp-engine] host.emit(${event.kind}) 抛错，已忽略：${(error as Error).message}`);
      });
  }

  /** 让 SDK 里已到达但尚在异步处理链中的通知先入队，再等宿主处理完全部事件。 */
  async drain(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
    await this.chain;
  }

  trackPermission(cancel: () => void): () => void {
    this.pendingPermissions.add(cancel);
    return () => this.pendingPermissions.delete(cancel);
  }

  cancelPendingPermissions(): void {
    for (const cancel of this.pendingPermissions) cancel();
    this.pendingPermissions.clear();
  }

  get text(): string {
    return this.textParts.join("");
  }

  get toolCallCount(): number {
    return this.toolIds.size;
  }
}

interface SessionRuntime {
  zcodeSessionId: string;
  proc?: AgentProcess;
  fingerprint?: string;
  acpSessionId?: string;
  appliedModel?: string;
  appliedEffort?: string;
  /** 正在等用户发授权码的登录；originalPrompt 是触发授权的那条消息，授权成功后接着处理。 */
  resumePrompt?: { prompt: string; images?: TurnInput["images"] };
  pendingAuth?: { login: AuthLogin; originalPrompt: string; images?: TurnInput["images"] };
  turn?: ActiveTurn;
  busy: boolean;
}

/** 进程身份：命令、参数、env、cwd 任一变化都要换进程。只在内存里比较，不落盘、不进日志。 */
function fingerprintOf(agent: AcpAgentConfig, cwd: string): string {
  const env = Object.entries(agent.env ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify([agent.id, agent.command, agent.args ?? [], env, cwd]);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error)
    return String((error as { message: unknown }).message);
  return String(error);
}

class AcpEngineImpl implements AcpEngine {
  private readonly sessions = new Map<string, SessionRuntime>();
  private readonly store: SessionStore;
  private readonly log: (msg: string) => void;
  private readonly cancelTimeoutMs: number;
  private readonly stateDir: string;
  private readonly createAuthLogin: (agent: AcpAgentConfig) => AuthLogin;
  private disposed = false;

  constructor(opts: AcpEngineInternalOptions) {
    this.log = opts.log ?? (() => {});
    this.store = new SessionStore(opts.stateDir, this.log);
    this.cancelTimeoutMs = opts.cancelTimeoutMs ?? DEFAULT_CANCEL_TIMEOUT_MS;
    this.createAuthLogin = opts.createAuthLogin ?? ((agent) => new AuthLogin(agent));
    this.stateDir = opts.stateDir;
  }

  private runtimeFor(zcodeSessionId: string): SessionRuntime {
    let rt = this.sessions.get(zcodeSessionId);
    if (!rt) {
      rt = { zcodeSessionId, busy: false };
      this.sessions.set(zcodeSessionId, rt);
    }
    return rt;
  }

  async runTurn(input: TurnInput, host: TurnHost): Promise<TurnResult> {
    if (this.disposed)
      return { stopReason: "error", error: "ACP 引擎已关闭", text: "", toolCallCount: 0 };
    if (input.signal.aborted) return { stopReason: "cancelled", text: "", toolCallCount: 0 };
    const rt = this.runtimeFor(input.zcodeSessionId);
    if (rt.busy)
      return {
        stopReason: "error",
        error: "该会话已有进行中的 ACP 回合",
        text: "",
        toolCallCount: 0,
      };
    rt.busy = true;
    const turn = new ActiveTurn(host, input.signal, this.log);
    rt.turn = turn;
    try {
      return await this.executeTurn(rt, input, turn);
    } finally {
      turn.cancelPendingPermissions();
      if (rt.turn === turn) rt.turn = undefined;
      rt.busy = false;
    }
  }

  private async executeTurn(
    rt: SessionRuntime,
    input: TurnInput,
    turn: ActiveTurn,
  ): Promise<TurnResult> {
    const result = (stopReason: TurnResult["stopReason"], error?: string): TurnResult => ({
      stopReason,
      ...(error ? { error } : {}),
      text: turn.text,
      toolCallCount: turn.toolCallCount,
    });

    // 上一轮因为没登录而发起了授权：这一条消息按「授权码 / 取消」处理。
    if (rt.pendingAuth) {
      const handled = await this.handlePendingAuth(rt, input, turn);
      if (handled !== "continue") {
        await turn.drain();
        return result(input.signal.aborted ? "cancelled" : "end_turn");
      }
      // 授权成功：用新的登录状态重连，接着处理触发授权的那条消息。
      await this.dropConnection(rt);
    }
    const promptText = rt.resumePrompt?.prompt ?? input.prompt;
    const promptImages = rt.resumePrompt ? rt.resumePrompt.images : input.images;
    rt.resumePrompt = undefined;

    let proc: AgentProcess;
    try {
      proc = await this.ensureConnection(rt, input, turn);
      await this.applyModel(rt, proc, input.modelId, turn, input);
      await this.applyEffort(rt, proc, input.effort, turn);
    } catch (error) {
      await turn.drain();
      if (error instanceof AbortedError || input.signal.aborted) return result("cancelled");
      return result("error", errorMessage(error));
    }

    const prompt: unknown[] = [{ type: "text", text: promptText }];
    for (const image of promptImages ?? [])
      prompt.push({ type: "image", mimeType: image.mimeType, data: image.data });

    const promptPromise = proc.request<unknown>("session/prompt", {
      sessionId: rt.acpSessionId,
      prompt,
    });
    let killedForTimeout = false;
    let cancelTimer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      const onAbort = () => {
        turn.cancelPendingPermissions();
        void proc.notify("session/cancel", { sessionId: rt.acpSessionId });
        cancelTimer = setTimeout(() => {
          killedForTimeout = true;
          this.log(
            `[acp-engine] 会话 ${rt.zcodeSessionId} 取消超时（${this.cancelTimeoutMs}ms），结束智能体进程`,
          );
          void this.dropConnection(rt);
          resolve("timeout");
        }, this.cancelTimeoutMs);
      };
      if (input.signal.aborted) onAbort();
      else input.signal.addEventListener("abort", onAbort, { once: true });
      void promptPromise.then(
        () => input.signal.removeEventListener("abort", onAbort),
        () => input.signal.removeEventListener("abort", onAbort),
      );
    });

    let response: unknown;
    try {
      const winner = await Promise.race([promptPromise, timedOut]);
      if (winner === "timeout") {
        await turn.drain();
        return result("cancelled");
      }
      response = winner;
    } catch (error) {
      await turn.drain();
      if (input.signal.aborted || killedForTimeout) return result("cancelled");
      if (error instanceof AgentExitedError || !proc.isAlive) {
        // 进程崩溃：丢掉连接，下一轮重新 initialize + session/load。
        await this.dropConnection(rt);
      }
      if (isAuthRequiredError(error)) {
        // 账号没登录：在对话里给出授权链接，等用户把授权码发回来（见 auth.ts）。
        const started = await this.startAuth(rt, input, promptText, promptImages, turn);
        await turn.drain();
        if (started) return result("end_turn");
      }
      return result("error", errorMessage(error));
    } finally {
      if (cancelTimer) clearTimeout(cancelTimer);
    }

    await turn.drain();
    const usage = promptUsageEvent(response);
    if (usage) {
      turn.emit(usage);
      await turn.drain();
    }
    const stopReason = mapStopReason((response as { stopReason?: unknown } | null)?.stopReason);
    // 智能体没理会取消、但回合恰好正常结束时，仍按 cancelled 报告，和用户的操作一致。
    return result(input.signal.aborted ? "cancelled" : stopReason);
  }

  /** 确保有存活的连接与 ACP 会话；必要时新起进程并 session/load 或 session/new。 */
  private async ensureConnection(
    rt: SessionRuntime,
    input: TurnInput,
    turn: ActiveTurn,
  ): Promise<AgentProcess> {
    const fingerprint = fingerprintOf(input.agent, input.cwd);
    if (rt.proc && rt.proc.isAlive && rt.fingerprint === fingerprint && rt.acpSessionId)
      return rt.proc;
    if (rt.proc) await this.dropConnection(rt);

    // 握手完成前 proc 还没赋值：回调经 holder 取值，未就绪时按「回合外消息」忽略。
    const holder: { proc?: AgentProcess } = {};
    const proc = await AgentProcess.start(
      input.agent,
      input.cwd,
      {
        onUpdate: (params) => this.handleUpdate(rt, holder.proc, params),
        onPermission: (params, signal) => this.handlePermission(rt, holder.proc, params, signal),
      },
      this.log,
      input.signal,
    );
    holder.proc = proc;
    rt.proc = proc;
    rt.fingerprint = fingerprint;
    rt.appliedModel = undefined;
    rt.appliedEffort = undefined;
    rt.acpSessionId = undefined;
    void proc.exited.then((info) => {
      if (rt.proc === proc) {
        this.log(
          `[acp-engine] 会话 ${rt.zcodeSessionId} 的智能体进程退出（code=${info.code ?? "null"}），下一轮将重连`,
        );
      }
    });

    try {
      const mapping = await this.store.get(input.zcodeSessionId);
      if (mapping && mapping.agentId === input.agent.id && proc.supportsLoadSession) {
        turn.replaying = true;
        try {
          await proc.request(
            "session/load",
            { sessionId: mapping.acpSessionId, cwd: input.cwd, mcpServers: [] },
            input.signal,
          );
          // 回放的 update 可能还在 SDK 异步链里：让出一个宏任务后再关闭回放过滤。
          await new Promise<void>((resolve) => setImmediate(resolve));
          rt.acpSessionId = mapping.acpSessionId;
          this.log(`[acp-engine] 会话 ${rt.zcodeSessionId} 已通过 session/load 恢复`);
        } catch (error) {
          if (error instanceof AbortedError || error instanceof AgentExitedError) throw error;
          this.log(`[acp-engine] session/load 失败，改为新建会话：${errorMessage(error)}`);
          turn.emit({ kind: "notice", message: "无法恢复之前的 ACP 会话上下文，已新建会话" });
        } finally {
          turn.replaying = false;
        }
      }
      if (!rt.acpSessionId) {
        const created = await proc.request<{ sessionId?: unknown }>(
          "session/new",
          { cwd: input.cwd, mcpServers: [] },
          input.signal,
        );
        if (typeof created?.sessionId !== "string")
          throw new Error("ACP 智能体 session/new 没有返回 sessionId");
        // 记下智能体报的模型清单（带版本号），下次启动时模型选择器按它显示。
        writeModelCache(
          this.stateDir,
          input.agent.id,
          modelOptionsFromConfigOptions((created as { configOptions?: unknown }).configOptions),
        );
        rt.acpSessionId = created.sessionId;
        await this.store.set(input.zcodeSessionId, input.agent.id, created.sessionId);
      }
      return proc;
    } catch (error) {
      await this.dropConnection(rt);
      throw error;
    }
  }

  /** 发起授权：成功给出链接返回 true；生成不了链接返回 false（调用方按普通错误处理）。 */
  private async startAuth(
    rt: SessionRuntime,
    input: TurnInput,
    originalPrompt: string,
    images: TurnInput["images"],
    turn: ActiveTurn,
  ): Promise<boolean> {
    await rt.pendingAuth?.login.cancel();
    rt.pendingAuth = undefined;
    const login = this.createAuthLogin(input.agent);
    try {
      const url = await login.start();
      rt.pendingAuth = { login, originalPrompt, ...(images?.length ? { images } : {}) };
      this.log(`[acp-engine] 会话 ${rt.zcodeSessionId} 需要授权，已生成授权链接`);
      turn.emit({ kind: "text", delta: authInstructions(url) });
      return true;
    } catch (error) {
      this.log(`[acp-engine] 会话 ${rt.zcodeSessionId} 发起授权失败：${errorMessage(error)}`);
      turn.emit({
        kind: "text",
        delta: `Claude 账号还没有登录，但没能生成授权链接（${errorMessage(error)}）。请确认网络正常后再发一次消息。`,
      });
      return true;
    }
  }

  /**
   * 处理等待授权期间用户发来的消息。
   * 返回 "continue" 表示授权成功、应接着处理原来的问题；"handled" 表示这一轮到此为止。
   */
  private async handlePendingAuth(
    rt: SessionRuntime,
    input: TurnInput,
    turn: ActiveTurn,
  ): Promise<"continue" | "handled"> {
    const pending = rt.pendingAuth;
    if (!pending) return "continue";
    const text = input.prompt.trim();
    if (isCancelAuthText(text)) {
      await pending.login.cancel();
      rt.pendingAuth = undefined;
      turn.emit({ kind: "text", delta: "已取消授权。想再用的时候直接发消息，我会重新给你授权链接。" });
      return "handled";
    }
    if (!pending.login.isActive) {
      // 链接放太久失效了（或登录命令意外退出）：重新发起，原问题保留。
      await this.startAuth(rt, input, pending.originalPrompt, pending.images, turn);
      return "handled";
    }
    if (!looksLikeAuthCode(text)) {
      turn.emit({
        kind: "text",
        delta:
          "我还在等授权码：在指纹浏览器里打开上面的链接并登录后，把页面上的 Authentication code 整段复制，作为一条消息发给我。不想授权了就发「取消授权」。",
      });
      return "handled";
    }
    const outcome = await pending.login.submitCode(text);
    if (outcome.ok) {
      rt.pendingAuth = undefined;
      rt.resumePrompt = {
        prompt: pending.originalPrompt,
        ...(pending.images?.length ? { images: pending.images } : {}),
      };
      this.log(`[acp-engine] 会话 ${rt.zcodeSessionId} 授权成功`);
      turn.emit({ kind: "text", delta: "授权成功，接着处理你刚才的问题。\n\n" });
      return "continue";
    }
    this.log(`[acp-engine] 会话 ${rt.zcodeSessionId} 授权失败`);
    turn.emit({
      kind: "text",
      delta: `授权没有成功（${outcome.reason ?? "授权码不对或已经过期"}）。我重新给你一条链接：\n\n`,
    });
    await this.startAuth(rt, input, pending.originalPrompt, pending.images, turn);
    return "handled";
  }

  /** 切思考强度：`default` 或未指定不发请求；智能体不支持（没有 effort 配置项）时只提示一次，不影响回合。 */
  private async applyEffort(
    rt: SessionRuntime,
    proc: AgentProcess,
    effort: string | undefined,
    turn: ActiveTurn,
  ): Promise<void> {
    if (!effort || effort === "default" || effort === rt.appliedEffort) return;
    try {
      await proc.request(
        "session/set_config_option",
        { sessionId: rt.acpSessionId, configId: "effort", value: effort },
        turn.signal,
      );
      rt.appliedEffort = effort;
    } catch (error) {
      if (error instanceof AbortedError || error instanceof AgentExitedError) throw error;
      this.log(`[acp-engine] 切换思考强度 ${effort} 失败：${errorMessage(error)}`);
      rt.appliedEffort = effort; // 同一会话不反复重试、不反复提示
      turn.emit({ kind: "notice", message: `切换思考强度「${effort}」失败，继续使用当前强度` });
    }
  }

  /** 切模型：`default` 或未指定表示用智能体自己的默认值，不发请求。 */
  private async applyModel(
    rt: SessionRuntime,
    proc: AgentProcess,
    modelId: string | undefined,
    turn: ActiveTurn,
    input: TurnInput,
  ): Promise<void> {
    // 界面上的模型 id 可能是带版本号的显示名，先换成发给智能体的值。
    const value = modelId ? (input.agent.modelValues?.[modelId] ?? modelId) : undefined;
    if (!value || value === "default" || value === rt.appliedModel) return;
    try {
      await proc.request(
        "session/set_config_option",
        { sessionId: rt.acpSessionId, configId: "model", value },
        turn.signal,
      );
      rt.appliedModel = value;
    } catch (error) {
      if (error instanceof AbortedError || error instanceof AgentExitedError) throw error;
      this.log(`[acp-engine] 切换模型 ${modelId} 失败：${errorMessage(error)}`);
      turn.emit({ kind: "notice", message: `切换模型「${modelId}」失败，继续使用当前模型` });
    }
  }

  private handleUpdate(rt: SessionRuntime, proc: AgentProcess | undefined, params: unknown): void {
    const turn = rt.turn;
    if (!turn || !proc || rt.proc !== proc) {
      this.log(`[acp-engine] 会话 ${rt.zcodeSessionId} 收到回合外的 session/update，已忽略`);
      return;
    }
    if (turn.replaying) return;
    const update =
      params && typeof params === "object" ? (params as { update?: unknown }).update : undefined;
    const mapped = mapSessionUpdate(update, turn.memory);
    if (mapped.ignored) this.log(`[acp-engine] ${mapped.ignored}`);
    for (const event of mapped.events) turn.emit(event);
  }

  private async handlePermission(
    rt: SessionRuntime,
    proc: AgentProcess | undefined,
    params: unknown,
    requestSignal: AbortSignal,
  ): Promise<PermissionOutcome> {
    const cancelled: PermissionOutcome = { outcome: { outcome: "cancelled" } };
    const turn = rt.turn;
    if (!turn || !proc || rt.proc !== proc || turn.signal.aborted) return cancelled;
    const request = mapPermissionRequest(params, turn.memory);
    // 先让宿主处理完之前的事件（尤其是对应的 tool_start），弹窗才能挂到正确的工具卡片上。
    await turn.drain();
    if (turn.signal.aborted || requestSignal.aborted) return cancelled;

    const decision = await new Promise<PermissionDecision>((resolve) => {
      let done = false;
      const finish = (value: PermissionDecision) => {
        if (done) return;
        done = true;
        untrack();
        requestSignal.removeEventListener("abort", onCancel);
        resolve(value);
      };
      const onCancel = () => finish({ cancelled: true });
      const untrack = turn.trackPermission(onCancel);
      requestSignal.addEventListener("abort", onCancel, { once: true });
      turn.host.requestPermission(request).then(finish, (error: unknown) => {
        this.log(`[acp-engine] host.requestPermission 抛错，按取消处理：${errorMessage(error)}`);
        finish({ cancelled: true });
      });
    });
    if ("cancelled" in decision) return cancelled;
    this.log(`[acp-engine] 权限决定 ${request.toolName}：${decision.optionId}`);
    return { outcome: { outcome: "selected", optionId: decision.optionId } };
  }

  private async dropConnection(rt: SessionRuntime): Promise<void> {
    const proc = rt.proc;
    rt.proc = undefined;
    rt.acpSessionId = undefined;
    rt.appliedModel = undefined;
    rt.appliedEffort = undefined;
    if (proc) await proc.kill();
  }

  /** 结束该会话的智能体进程。映射保留在 sessions.json，下次打开同一会话仍可 session/load。 */
  async disposeSession(zcodeSessionId: string): Promise<void> {
    const rt = this.sessions.get(zcodeSessionId);
    if (!rt) return;
    rt.turn?.cancelPendingPermissions();
    await rt.pendingAuth?.login.cancel();
    rt.pendingAuth = undefined;
    await this.dropConnection(rt);
    if (!rt.busy) this.sessions.delete(zcodeSessionId);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.all([...this.sessions.keys()].map((id) => this.disposeSession(id)));
  }
}

export function createAcpEngineWithOptions(opts: AcpEngineInternalOptions): AcpEngine {
  return new AcpEngineImpl(opts);
}

/** 契约入口（DESIGN §4.1）。 */
export function createAcpEngine(opts: CreateAcpEngineOptions): AcpEngine {
  return new AcpEngineImpl(opts);
}
