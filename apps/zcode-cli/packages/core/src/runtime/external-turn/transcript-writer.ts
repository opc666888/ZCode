/**
 * 把外部智能体的中性事件写成 ZCode 会话事实（事件日志 + 消息库），一个 writer 绑定一个会话。
 *
 * 事件顺序与 runRegularTurnLoop 的一个 model step 对齐（投影与冷恢复都按它还原）：
 *   assistant message 落库 + step-start part → ModelStreaming(start)
 *   → text_start/text_delta/text_end 或 reasoning_*（每块一个 blockIndex）
 *   → ToolCallScheduled（pending tool part）→ ToolCallStarted → ToolCallResult/Error（completed part）
 *   → 下一段正文到达前收口本 step：text/reasoning part 落库 + ModelComplete + assistant 完成态。
 * 外部智能体自己执行工具，所以工具事件与正文交错到达；同一 step 内的多个工具视为并行批次。
 */
import { structuredPatch } from "diff";
import type {
  MessageId,
  ModelUsage,
  PartId,
  SessionEvent,
  ToolCallId,
  TraceContext,
} from "@zcode/contracts";
import {
  COMPLETED_TOOL_PART_METADATA_SCHEMA_VERSION,
  SessionEventType,
  createMessageId,
  createPartId,
} from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { ExternalTurnEvent } from "./contract.js";

type ToolStartEvent = Extract<ExternalTurnEvent, { kind: "tool_start" }>;
type ToolUpdateEvent = Extract<ExternalTurnEvent, { kind: "tool_update" }>;
type PlanEvent = Extract<ExternalTurnEvent, { kind: "plan" }>;

interface StepBlock {
  type: "text" | "reasoning";
  text: string;
  blockIndex: number;
  startedAt: number;
}

interface OpenStep {
  messageId: MessageId;
  createdAt: number;
  nextBlockIndex: number;
  blocks: StepBlock[];
  open: StepBlock | null;
  toolCount: number;
}

interface ToolState {
  toolCallId: string;
  toolName: string;
  title: string;
  input: Record<string, unknown>;
  messageId: MessageId;
  partId: PartId;
  blockIndex: number;
  scheduledAt: number;
  /** 并入 tool part metadata 的附加字段（子智能体 childSessionId 等）。 */
  extraMetadata?: Record<string, unknown>;
  started: boolean;
  settled: boolean;
  outputText: string;
  diffs: NonNullable<ToolUpdateEvent["diffs"]>;
}

export interface TranscriptWriterOptions {
  runtime: AgentRuntimeInternal;
  /** 本轮 user message；每个 assistant step 的 parentID。 */
  parentMessageId: MessageId;
  traceContext: TraceContext;
  /** 本轮事件收集器（TurnComplete.usage 从其中的 ModelComplete 汇总）。 */
  events: SessionEvent[];
  querySource: "main_turn" | "subagent";
}

function asInputRecord(input: unknown): Record<string, unknown> {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    return { ...(input as Record<string, unknown>) };
  }
  return input === undefined ? {} : { value: input };
}

function toFileDiffDisplay(diff: { path: string; oldText: string | null; newText: string }) {
  const patch = structuredPatch(diff.path, diff.path, diff.oldText ?? "", diff.newText, "", "", {
    context: 3,
  });
  let additions = 0;
  let deletions = 0;
  for (const hunk of patch.hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith("+")) additions += 1;
      else if (line.startsWith("-")) deletions += 1;
    }
  }
  return {
    kind: "file_diff" as const,
    filePath: diff.path,
    additions,
    deletions,
    structuredPatch: patch.hunks.map((hunk) => ({
      oldStart: hunk.oldStart,
      oldLines: hunk.oldLines,
      newStart: hunk.newStart,
      newLines: hunk.newLines,
      lines: [...hunk.lines],
    })),
  };
}

export class ExternalTranscriptWriter {
  readonly #runtime: AgentRuntimeInternal;
  readonly #parentMessageId: MessageId;
  readonly #trace: TraceContext;
  readonly #events: SessionEvent[];
  readonly #querySource: "main_turn" | "subagent";
  #step: OpenStep | null = null;
  readonly #tools = new Map<string, ToolState>();
  #planCount = 0;
  #lastText = "";
  #toolCallCount = 0;
  #usage: ModelUsage | undefined;

  constructor(options: TranscriptWriterOptions) {
    this.#runtime = options.runtime;
    this.#parentMessageId = options.parentMessageId;
    this.#trace = options.traceContext;
    this.#events = options.events;
    this.#querySource = options.querySource;
  }

  /** 最后一个 step 的正文；TurnComplete.response 与子智能体摘要都用它。 */
  get lastText(): string {
    return this.#lastText;
  }

  get toolCallCount(): number {
    return this.#toolCallCount;
  }

  hasTool(toolCallId: string): boolean {
    return this.#tools.has(toolCallId);
  }

  /** 给已登记的工具补 part 级 metadata，并立即重新落库一次（冷恢复靠它重建子智能体行）。 */
  async annotateTool(toolCallId: string, metadata: Record<string, unknown>): Promise<void> {
    const tool = this.#tools.get(toolCallId);
    if (!tool) return;
    tool.extraMetadata = { ...tool.extraMetadata, ...metadata };
    if (!tool.settled) await this.#persistToolPart(tool, { status: "pending" });
  }

  toolInput(toolCallId: string): Record<string, unknown> | undefined {
    return this.#tools.get(toolCallId)?.input;
  }

  /** ACP usage 是本轮累计值：只保留最新一份，写进最后一个 ModelComplete。 */
  setUsage(usage: ModelUsage): void {
    this.#usage = usage;
  }

  async text(delta: string): Promise<void> {
    await this.#appendBlock("text", delta);
  }

  async thought(delta: string): Promise<void> {
    await this.#appendBlock("reasoning", delta);
  }

  async toolStart(event: ToolStartEvent): Promise<void> {
    const existing = this.#tools.get(event.toolCallId);
    if (existing) {
      await this.toolUpdate({ kind: "tool_update", toolCallId: event.toolCallId, input: event.input });
      return;
    }
    const step = await this.#ensureStep(false);
    await this.#closeOpenBlock(step);
    const tool: ToolState = {
      toolCallId: event.toolCallId,
      toolName: event.toolName || event.title || "tool",
      title: event.title,
      input: asInputRecord(event.input),
      messageId: step.messageId,
      partId: createPartId(),
      blockIndex: step.nextBlockIndex++,
      scheduledAt: Date.now(),
      started: false,
      settled: false,
      outputText: "",
      diffs: [],
    };
    step.toolCount += 1;
    this.#toolCallCount += 1;
    this.#tools.set(tool.toolCallId, tool);
    await this.#emitScheduled(tool);
    await this.#persistToolPart(tool, { status: "pending" });
  }

  async toolUpdate(event: ToolUpdateEvent): Promise<void> {
    const tool = this.#tools.get(event.toolCallId);
    if (!tool || tool.settled) return;
    if (event.title) tool.title = event.title;
    if (event.input !== undefined) {
      tool.input = asInputRecord(event.input);
      // 输入定稿（Claude Code 先发空 input 再补全）：重发 Scheduled，投影按同一 toolCallId upsert。
      await this.#emitScheduled(tool);
    }
    if (event.diffs?.length) tool.diffs = event.diffs;
    if (event.text) tool.outputText = event.text;
    if (event.status === "in_progress") await this.#ensureStarted(tool);
    if (event.status === "completed") await this.settleTool(tool.toolCallId, { success: true });
    if (event.status === "failed") {
      await this.settleTool(tool.toolCallId, {
        success: false,
        error: tool.outputText || `${tool.toolName} failed`,
      });
    }
  }

  /** ACP plan → 合成一条 TodoWrite 调用：投影现有 plan 解析与 todo 工具卡直接复用。 */
  async plan(event: PlanEvent): Promise<void> {
    this.#planCount += 1;
    const toolCallId = `acp_plan_${this.#trace.turnId ?? "turn"}_${this.#planCount}`;
    const todos = event.entries.map((entry) => ({
      content: entry.content,
      status: entry.status,
      activeForm: entry.content,
    }));
    await this.toolStart({
      kind: "tool_start",
      toolCallId,
      toolName: "TodoWrite",
      title: "TodoWrite",
      input: { todos },
    });
    const tool = this.#tools.get(toolCallId);
    if (tool) tool.outputText = "Todos have been modified successfully.";
    await this.settleTool(toolCallId, { success: true });
  }

  async settleTool(
    toolCallId: string,
    result: { success: true } | { success: false; error: string; cancelled?: boolean },
  ): Promise<void> {
    const tool = this.#tools.get(toolCallId);
    if (!tool || tool.settled) return;
    await this.#ensureStarted(tool);
    tool.settled = true;
    const endedAt = Date.now();
    const display = tool.diffs[0] ? toFileDiffDisplay(tool.diffs[0]) : undefined;
    const content =
      tool.outputText ||
      (tool.diffs.length > 0
        ? tool.diffs.map((diff) => `Updated ${diff.path}`).join("\n")
        : result.success
          ? ""
          : result.error);
    if (result.success) {
      await this.#emit(SessionEventType.ToolCallResult, {
        toolCallId: tool.toolCallId as ToolCallId,
        result: { success: true, content, ...(display ? { display } : {}) },
        duration: endedAt - tool.scheduledAt,
      });
      await this.#persistToolPart(tool, {
        status: "completed",
        output: content,
        metadata: {
          schemaVersion: COMPLETED_TOOL_PART_METADATA_SCHEMA_VERSION,
          ...(display ? { display } : {}),
        },
        start: tool.scheduledAt,
        end: endedAt,
      });
      return;
    }
    await this.#emit(SessionEventType.ToolCallError, {
      toolCallId: tool.toolCallId as ToolCallId,
      error: {
        type: result.cancelled ? "ToolCancelled" : "ToolExecutionError",
        message: result.error,
      },
    });
    await this.#persistToolPart(tool, {
      status: "error",
      error: result.error,
      start: tool.scheduledAt,
      end: endedAt,
    });
  }

  /**
   * 回合收口：未收到终态的工具按 outcome 收口（正常结束视为完成，取消/失败视为错误），
   * 再关闭当前 step。幂等：重复调用只会再写一次空操作。
   */
  async finish(outcome: { cancelled: boolean; error?: string }): Promise<void> {
    for (const tool of this.#tools.values()) {
      if (tool.settled) continue;
      if (outcome.cancelled || outcome.error) {
        await this.settleTool(tool.toolCallId, {
          success: false,
          error: outcome.error ?? "Cancelled",
          cancelled: outcome.cancelled,
        });
      } else {
        await this.settleTool(tool.toolCallId, { success: true });
      }
    }
    await this.#finishStep(outcome.cancelled ? "cancelled" : outcome.error ? "error" : "stop");
  }

  async #appendBlock(type: StepBlock["type"], delta: string): Promise<void> {
    if (delta.length === 0) return;
    const step = await this.#ensureStep(true);
    if (step.open?.type !== type) {
      await this.#closeOpenBlock(step);
      const block: StepBlock = {
        type,
        text: "",
        blockIndex: step.nextBlockIndex++,
        startedAt: Date.now(),
      };
      step.open = block;
      step.blocks.push(block);
      await this.#emitStreaming(step, type === "text" ? "text_start" : "reasoning_start", "");
    }
    step.open!.text += delta;
    await this.#emitStreaming(step, type === "text" ? "text_delta" : "reasoning_delta", delta);
  }

  /** 正文在工具之后到达 = 外部智能体开始了下一次模型往返：先收口当前 step。 */
  async #ensureStep(contentBlock: boolean): Promise<OpenStep> {
    if (this.#step && contentBlock && this.#step.toolCount > 0) {
      await this.#finishStep("tool_calls");
    }
    if (this.#step) return this.#step;
    const step: OpenStep = {
      messageId: createMessageId(),
      createdAt: Date.now(),
      nextBlockIndex: 0,
      blocks: [],
      open: null,
      toolCount: 0,
    };
    this.#step = step;
    await this.#runtime.persistAssistantMessage(
      step.messageId,
      this.#parentMessageId,
      step.createdAt,
      undefined,
      this.#trace,
    );
    await this.#runtime.persistPart(
      {
        id: createPartId(),
        sessionID: this.#runtime.sessionId,
        messageID: step.messageId,
        type: "step-start",
      },
      this.#trace,
    );
    await this.#emitStreaming(step, "start", "");
    return step;
  }

  async #closeOpenBlock(step: OpenStep): Promise<void> {
    const open = step.open;
    if (!open) return;
    step.open = null;
    await this.#emitStreaming(step, open.type === "text" ? "text_end" : "reasoning_end", "");
  }

  async #finishStep(stopReason: string): Promise<void> {
    const step = this.#step;
    if (!step) return;
    await this.#closeOpenBlock(step);
    this.#step = null;
    const endedAt = Date.now();
    for (const block of step.blocks) {
      if (block.text.length === 0) continue;
      await this.#runtime.persistPart(
        {
          id: createPartId(),
          sessionID: this.#runtime.sessionId,
          messageID: step.messageId,
          type: block.type,
          text: block.text,
          blockIndex: block.blockIndex,
          time: { start: block.startedAt, end: endedAt },
        },
        this.#trace,
      );
    }
    const content = step.blocks
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    if (content.length > 0 || step.toolCount === 0) this.#lastText = content;
    // usage 只挂在最后一个 step：前面的 step 结束时还不知道整轮用量。
    const isLast = stopReason !== "tool_calls";
    const usage: ModelUsage = isLast && this.#usage ? this.#usage : {};
    await this.#emit(SessionEventType.ModelComplete, {
      content,
      querySource: this.#querySource,
      stopReason,
      usage,
      toolCallCount: step.toolCount,
    });
    await this.#runtime.persistAssistantMessage(
      step.messageId,
      this.#parentMessageId,
      step.createdAt,
      {
        completed: endedAt,
        finish: stopReason,
        ...(isLast && this.#usage
          ? {
              tokens: {
                input: this.#usage.inputTokens ?? 0,
                output: this.#usage.outputTokens ?? 0,
                reasoning: 0,
                cache: { read: this.#usage.cacheReadTokens ?? 0, write: 0 },
              },
            }
          : {}),
      },
      this.#trace,
    );
  }

  async #ensureStarted(tool: ToolState): Promise<void> {
    if (tool.started) return;
    tool.started = true;
    await this.#emit(SessionEventType.ToolCallStarted, {
      toolCallId: tool.toolCallId as ToolCallId,
      toolName: tool.toolName,
      startedAt: new Date(),
    });
  }

  async #emitScheduled(tool: ToolState): Promise<void> {
    const toolCallId = tool.toolCallId as ToolCallId;
    await this.#emit(SessionEventType.ToolCallScheduled, {
      toolCallId,
      assistantMessageId: tool.messageId,
      toolName: tool.toolName,
      input: tool.input,
      canRunParallel: true,
      schedule: { parallelGroups: [[toolCallId]], executionOrder: [toolCallId] },
    });
  }

  async #persistToolPart(
    tool: ToolState,
    state:
      | { status: "pending" }
      | {
          status: "completed";
          output: string;
          metadata: Record<string, unknown>;
          start: number;
          end: number;
        }
      | { status: "error"; error: string; start: number; end: number },
  ): Promise<void> {
    const base = {
      id: tool.partId,
      sessionID: this.#runtime.sessionId,
      messageID: tool.messageId,
      type: "tool" as const,
      callID: tool.toolCallId,
      blockIndex: tool.blockIndex,
      tool: tool.toolName,
      metadata: { source: "acp", title: tool.title, ...tool.extraMetadata },
    };
    if (state.status === "pending") {
      await this.#runtime.persistPart(
        {
          ...base,
          state: {
            status: "pending",
            input: tool.input,
            raw: JSON.stringify({ tool: tool.toolName, input: tool.input }),
          },
        },
        this.#trace,
      );
      return;
    }
    await this.#runtime.persistPart(
      {
        ...base,
        state:
          state.status === "completed"
            ? {
                status: "completed",
                input: tool.input,
                output: state.output,
                title: tool.title || tool.toolName,
                metadata: state.metadata,
                time: { start: state.start, end: state.end },
              }
            : {
                status: "error",
                input: tool.input,
                error: state.error,
                time: { start: state.start, end: state.end },
              },
      },
      this.#trace,
    );
  }

  async #emitStreaming(step: OpenStep, kind: string, delta: string): Promise<void> {
    await this.#emit(SessionEventType.ModelStreaming, {
      assistantMessageId: step.messageId,
      delta,
      done: false,
      kind,
    });
  }

  async #emit(type: SessionEventType, payload: unknown): Promise<void> {
    const event = this.#runtime.createEvent(type, payload, this.#trace);
    await this.#runtime.appendEvent(event, this.#trace);
    this.#events.push(event);
  }
}
