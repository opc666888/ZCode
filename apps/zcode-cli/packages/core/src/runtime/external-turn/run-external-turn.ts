/**
 * 外部引擎回合（acp-bridge，DESIGN §5）：替代 runRegularTurnLoop，并沿用上游 TurnComplete 收尾。
 *
 * 事件顺序：
 *   executeTurnCommand: TurnStarted → user message 落库（上游原逻辑）
 *   → runExternalTurn: engine.runTurn(host) —— host.emit 串行翻译为会话事件（父/子会话分流）
 *                                   host.requestPermission → PermissionBroker（交互登记表）
 *   → 收口：子会话 stop → 父 writer.finish → TurnComplete（成功）
 *   取消/失败：收口后抛错，由 executeTurnCommand 的既有 catch 写 TurnComplete(cancelled)/TurnError。
 */
import type {
  MessageId,
  ModelSelection,
  PermissionBrokerResult,
  SessionEvent,
  SessionGoal,
  ToolCallId,
  TraceContext,
  TraceId,
  TurnId,
} from "@zcode/contracts";
import { SessionEventType, createModelUsageSummaryFromEvents, traceContextToLogContext } from "../deps.js";
import { createTurnCancelledError } from "../helpers/index.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { ResolvedTurnAttachment, TurnResult } from "../types.js";
import { recordTurnUsageFact } from "../methods/usage-observability.js";
import type {
  ExternalPermissionDecision,
  ExternalPermissionRequest,
  ExternalTurnEngineAdapter,
  ExternalTurnEvent,
  ExternalTurnOutcome,
} from "./contract.js";
import { ExternalChildSession, isExternalSubagentToolName } from "./child-session.js";
import { ExternalTranscriptWriter } from "./transcript-writer.js";

export interface ExternalTurnContext {
  input: string;
  attachments?: readonly ResolvedTurnAttachment[];
  selection: ModelSelection;
  events: SessionEvent[];
  turnId: TurnId;
  traceId: TraceId;
  traceContext: TraceContext;
  signal: AbortSignal;
  userMessageId: MessageId;
  inputId?: string;
  turnStartedAtMs: number;
  startedTarget: SessionGoal | null;
  targetRunInputID: string;
}

const engines = new WeakMap<object, ExternalTurnEngineAdapter>();

/** AgentRuntime 构造时登记（deps.externalTurnEngine）；子 runtime 不继承。 */
export function bindExternalTurnEngine(
  runtime: object,
  engine: ExternalTurnEngineAdapter | undefined,
): void {
  if (engine) engines.set(runtime, engine);
}

/** 本轮冻结选择由外部引擎接管时返回引擎；否则 undefined（走上游原逻辑）。 */
export function resolveExternalTurnEngine(
  runtime: object,
  selection: ModelSelection | undefined,
): ExternalTurnEngineAdapter | undefined {
  const engine = engines.get(runtime);
  return engine?.handles(selection) ? engine : undefined;
}

function dataUrlImage(attachment: ResolvedTurnAttachment): { mimeType: string; data: string } | undefined {
  if (!attachment.mime.startsWith("image/")) return undefined;
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(attachment.url);
  return match ? { mimeType: match[1]!, data: match[2]! } : undefined;
}

function mapPermissionResult(
  request: ExternalPermissionRequest,
  result: PermissionBrokerResult,
): ExternalPermissionDecision {
  const byKind = (...kinds: ExternalPermissionRequest["options"][number]["kind"][]) =>
    kinds.map((kind) => request.options.find((option) => option.kind === kind)).find(Boolean);
  const always =
    (result.permissionUpdates?.length ?? 0) > 0 || (result.sessionPermissionUpdates?.length ?? 0) > 0;
  const option =
    result.decision === "deny"
      ? byKind("reject_once", "reject_always")
      : always
        ? byKind("allow_always", "allow_once")
        : byKind("allow_once", "allow_always");
  return option ? { optionId: option.optionId } : { cancelled: true };
}

class ExternalTurnRun {
  readonly #main: ExternalTranscriptWriter;
  /** Agent/Task 工具 toolCallId → 子会话。 */
  readonly #children = new Map<string, ExternalChildSession>();
  /** 各 writer 拥有的子智能体工具（含嵌套）。 */
  readonly #subagentTools = new Map<string, ExternalTranscriptWriter>();
  #chain: Promise<void> = Promise.resolve();
  #failure: unknown;

  constructor(
    private readonly runtime: AgentRuntimeInternal,
    private readonly ctx: ExternalTurnContext,
  ) {
    this.#main = new ExternalTranscriptWriter({
      runtime,
      parentMessageId: ctx.userMessageId,
      traceContext: ctx.traceContext,
      events: ctx.events,
      querySource: "main_turn",
    });
  }

  get main(): ExternalTranscriptWriter {
    return this.#main;
  }

  /** 引擎可能不 await emit：这里串成单链，保证事件按到达顺序落库。 */
  emit = (event: ExternalTurnEvent): Promise<void> => {
    this.#chain = this.#chain.then(async () => {
      if (this.#failure) return;
      try {
        await this.#handle(event);
      } catch (error) {
        this.#failure = error;
      }
    });
    return this.#chain;
  };

  async drain(): Promise<void> {
    await this.#chain;
    if (this.#failure) throw this.#failure;
  }

  requestPermission = async (
    request: ExternalPermissionRequest,
  ): Promise<ExternalPermissionDecision> => {
    // 先让已到达的 tool_call 落库，权限卡才能挂到对应工具行。
    await this.#chain;
    const { runtime, ctx } = this;
    const requestId = `acp_perm_${crypto.randomUUID()}`;
    const toolCallId = request.toolCallId as ToolCallId;
    const hasAlways = request.options.some((option) => option.kind === "allow_always");
    try {
      const response = runtime.permissionBroker.requestPermission(
        {
          requestId,
          sessionId: runtime.sessionId,
          turnId: ctx.turnId,
          traceId: ctx.traceId,
          toolCallId,
          toolName: request.toolName,
          input: request.input,
          mode: runtime.config.mode ?? "build",
          ruleId: "acp-agent",
          reason: request.title,
          riskLevel: "medium",
          suggestedPermissionUpdates: [],
          ...(hasAlways ? {} : { optionsPolicy: "no-always-allow" as const }),
          requestedAt: new Date(),
        },
        { signal: ctx.signal },
      );
      if (response.registered) await response.registered;
      await this.#appendMain(SessionEventType.PermissionRequested, {
        requestId,
        toolCallId,
        toolName: request.toolName,
        riskLevel: "medium",
        reason: request.title,
        input: request.input,
        suggestedPermissionUpdates: [],
        ...(hasAlways ? {} : { optionsPolicy: "no-always-allow" }),
      });
      const result = await response;
      await this.#appendMain(SessionEventType.PermissionResolved, {
        requestId,
        toolCallId,
        decision: result.decision,
        ...(result.reason ? { reason: result.reason } : {}),
      });
      return mapPermissionResult(request, result);
    } catch (error) {
      if (ctx.signal.aborted) return { cancelled: true };
      throw error;
    }
  };

  /** 收口全部子会话与主 writer；取消/失败时工具与子会话一并标记。 */
  async settle(outcome: { cancelled: boolean; error?: string }): Promise<void> {
    await this.#chain;
    for (const child of this.#children.values()) {
      if (child.stopped) continue;
      await child.stop(outcome.cancelled ? "cancelled" : outcome.error ? "failed" : "completed", outcome.error);
    }
    await this.#main.finish(outcome);
  }

  async #handle(event: ExternalTurnEvent): Promise<void> {
    switch (event.kind) {
      case "text":
        return (await this.#route(event.parentToolCallId)).text(event.delta);
      case "thought":
        return (await this.#route(event.parentToolCallId)).thought(event.delta);
      case "tool_start": {
        const writer = await this.#route(event.parentToolCallId);
        await writer.toolStart(event);
        if (isExternalSubagentToolName(event.toolName)) {
          this.#subagentTools.set(event.toolCallId, writer);
          await this.#maybeSpawn(event.toolCallId, false);
        }
        return;
      }
      case "tool_update": {
        const writer = await this.#route(event.parentToolCallId);
        if (this.#subagentTools.has(event.toolCallId)) {
          if (event.input !== undefined) await writer.toolUpdate({ ...event, status: undefined });
          await this.#maybeSpawn(event.toolCallId, false);
          const child = this.#children.get(event.toolCallId);
          if (child && (event.status === "completed" || event.status === "failed")) {
            await child.stop(event.status, event.status === "failed" ? event.text : undefined);
          }
          if (event.status !== undefined || event.text || event.diffs) {
            await writer.toolUpdate({ ...event, input: undefined });
          }
          return;
        }
        return writer.toolUpdate(event);
      }
      case "plan":
        return this.#main.plan(event);
      case "usage":
        this.#main.setUsage({
          ...(event.inputTokens === undefined ? {} : { inputTokens: event.inputTokens }),
          ...(event.outputTokens === undefined ? {} : { outputTokens: event.outputTokens }),
          ...(event.cachedTokens === undefined ? {} : { cacheReadTokens: event.cachedTokens }),
          totalTokens: (event.inputTokens ?? 0) + (event.outputTokens ?? 0),
        });
        return;
      case "mode":
      case "commands":
      case "notice":
        // 第一版只记日志：ACP 斜杠命令目前按普通文本透传给智能体（见 DESIGN §5.1-5 汇报的未完成项）。
        this.runtime.logger?.debug("ACP agent session update", {
          ...traceContextToLogContext(this.ctx.traceContext),
          event: "acp_bridge.session_update",
          module: "core.runtime.external_turn",
          kind: event.kind,
        });
        return;
    }
  }

  /** 带 parentToolCallId 的事件写进对应子会话；找不到子智能体时回落到主会话。 */
  async #route(parentToolCallId: string | undefined): Promise<ExternalTranscriptWriter> {
    if (!parentToolCallId) return this.#main;
    if (this.#subagentTools.has(parentToolCallId)) {
      const child = await this.#maybeSpawn(parentToolCallId, true);
      if (child && !child.stopped) return child.writer;
    }
    return this.#main;
  }

  /**
   * Claude Code 的 Agent 工具常先发空 input 再补全；有 prompt/description 或已有子事件时才建子会话，
   * 避免用空提示创建子会话。
   */
  async #maybeSpawn(toolCallId: string, force: boolean): Promise<ExternalChildSession | undefined> {
    const existing = this.#children.get(toolCallId);
    if (existing) return existing;
    const owner = this.#subagentTools.get(toolCallId);
    if (!owner) return undefined;
    const input = owner.toolInput(toolCallId);
    const ready = typeof input?.prompt === "string" || typeof input?.description === "string";
    if (!ready && !force) return undefined;
    const child = await ExternalChildSession.spawn(this.runtime, {
      parentToolCallId: toolCallId,
      input,
      selection: this.ctx.selection,
      parentTrace: this.ctx.traceContext,
      parentEvents: this.ctx.events,
    });
    this.#children.set(toolCallId, child);
    await owner.annotateTool(toolCallId, child.toolMetadata);
    return child;
  }

  async #appendMain(type: SessionEventType, payload: unknown): Promise<void> {
    const event = this.runtime.createEvent(type, payload, this.ctx.traceContext);
    await this.runtime.appendEvent(event, this.ctx.traceContext);
    this.ctx.events.push(event);
  }
}

export async function runExternalTurn(
  runtime: AgentRuntimeInternal,
  engine: ExternalTurnEngineAdapter,
  ctx: ExternalTurnContext,
): Promise<TurnResult> {
  const run = new ExternalTurnRun(runtime, ctx);
  const images = (ctx.attachments ?? []).flatMap((attachment) => {
    const image = dataUrlImage(attachment);
    return image ? [image] : [];
  });
  let outcome: ExternalTurnOutcome;
  try {
    outcome = await engine.runTurn(
      {
        sessionId: runtime.sessionId,
        cwd: runtime.workingDirectory,
        selection: ctx.selection,
        prompt: ctx.input,
        ...(images.length > 0 ? { images } : {}),
        signal: ctx.signal,
      },
      { emit: run.emit, requestPermission: run.requestPermission },
    );
    await run.drain();
  } catch (error) {
    await run
      .settle({
        cancelled: ctx.signal.aborted,
        error: error instanceof Error ? error.message : String(error),
      })
      .catch(() => undefined);
    throw error;
  }
  const cancelled = ctx.signal.aborted || outcome.stopReason === "cancelled";
  const error =
    outcome.stopReason === "error" ? (outcome.error ?? "External agent turn failed") : undefined;
  await run.settle({ cancelled, ...(error ? { error } : {}) });
  if (cancelled) throw createTurnCancelledError(ctx.signal.reason);
  if (error) throw new Error(error);

  const usage = createModelUsageSummaryFromEvents(ctx.events);
  await runtime.accountTargetTurnCompletion({
    inputID: ctx.targetRunInputID,
    startedAtMs: ctx.turnStartedAtMs,
    startedTarget: ctx.startedTarget,
    traceContext: ctx.traceContext,
    usage,
  });
  const response = run.main.lastText || outcome.text;
  const completeEvent = runtime.createEvent(
    SessionEventType.TurnComplete,
    {
      response,
      tokenCount: usage?.totalTokens ?? 0,
      usage,
      toolCallCount: run.main.toolCallCount,
      duration: Date.now() - ctx.turnStartedAtMs,
      resultType: "success",
      cacheStats: runtime.messageHistory.getCacheStats(),
      inputId: ctx.inputId,
    },
    ctx.traceContext,
  );
  await runtime.appendEvent(completeEvent, ctx.traceContext);
  ctx.events.push(completeEvent);
  await recordTurnUsageFact(runtime, {
    completedAt: Date.now(),
    events: ctx.events,
    startedAt: ctx.turnStartedAtMs,
    status: "completed",
    traceContext: ctx.traceContext,
    turnId: ctx.turnId,
    userMessageId: ctx.userMessageId,
  });
  runtime.turnNumber++;
  const projection = await runtime.rebuildProjection();
  runtime.logger?.info("External agent turn completed", {
    ...traceContextToLogContext(ctx.traceContext),
    event: "acp_bridge.turn.completed",
    module: "core.runtime.external_turn",
    status: "completed",
    stopReason: outcome.stopReason,
    toolCallCount: run.main.toolCallCount,
  });
  return {
    response,
    turnId: ctx.turnId,
    traceId: ctx.traceId,
    ...(usage ? { usage } : {}),
    events: ctx.events,
    projection,
  };
}
