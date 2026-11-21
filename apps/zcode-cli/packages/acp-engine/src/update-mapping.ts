/**
 * ACP session/update → 中性 EngineEvent 的纯映射（无 IO，便于逐分支单测）。
 *
 * 输入一律按「原始 JSON」处理：引擎用恒等解析器接收 session/update，
 * 不依赖 SDK 的 zod 结果，这样未知字段和扩展 _meta 都能原样拿到。
 */
import type { EngineEvent, PermissionRequest, TurnResult } from "./types.js";

type Json = Record<string, unknown>;

/** 映射过程中跨 update 记住的状态：toolCallId → 工具名 / 入参（tool_call_update 常常不再带这些）。 */
export interface ToolCallMemory {
  names: Map<string, string>;
  inputs: Map<string, unknown>;
}

export function createToolCallMemory(): ToolCallMemory {
  return { names: new Map(), inputs: new Map() };
}

export interface MappedUpdate {
  events: EngineEvent[];
  /** 没映射成事件的原因（未知类型等），供调用方写调试日志；不含任何正文。 */
  ignored?: string;
}

const TOOL_STATUSES = new Set(["pending", "in_progress", "completed", "failed"]);
const PLAN_STATUSES = new Set(["pending", "in_progress", "completed"]);
const PERMISSION_KINDS = new Set(["allow_once", "allow_always", "reject_once", "reject_always"]);
const STOP_REASONS = new Set([
  "end_turn",
  "max_tokens",
  "max_turn_requests",
  "refusal",
  "cancelled",
]);

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function claudeMeta(holder: unknown): Json | undefined {
  if (!isRecord(holder)) return undefined;
  const meta = holder._meta;
  if (!isRecord(meta)) return undefined;
  const claude = meta.claudeCode;
  return isRecord(claude) ? claude : undefined;
}

/** `_meta.claudeCode.parentToolUseId`：子智能体内部 update 的归属（见 claude-agent-acp stampParentToolUseId）。 */
export function parentToolCallIdOf(update: unknown): string | undefined {
  return str(claudeMeta(update)?.parentToolUseId) || undefined;
}

/** 工具名优先级：_meta.claudeCode.toolName → ACP name 字段 → 之前记住的名字 → title。 */
function toolNameOf(update: Json, memory: ToolCallMemory, toolCallId: string): string {
  return (
    str(claudeMeta(update)?.toolName) ||
    str(update.name) ||
    memory.names.get(toolCallId) ||
    str(update.title) ||
    "tool"
  );
}

function withParent<T extends EngineEvent>(event: T, parent: string | undefined): T {
  return parent ? { ...event, parentToolCallId: parent } : event;
}

function locationsOf(value: unknown): { path: string; line?: number }[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: { path: string; line?: number }[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const path = str(item.path);
    if (!path) continue;
    const line = num(item.line);
    out.push(line === undefined ? { path } : { path, line });
  }
  return out.length > 0 ? out : undefined;
}

interface ToolContent {
  diffs?: { path: string; oldText: string | null; newText: string }[];
  text?: string;
}

/** content 数组：diff 进 diffs；content(text) 与 terminal（_meta 带输出时）的文本拼成 text。 */
function toolContentOf(value: unknown): ToolContent {
  if (!Array.isArray(value)) return {};
  const diffs: { path: string; oldText: string | null; newText: string }[] = [];
  const texts: string[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    if (item.type === "diff") {
      const path = str(item.path);
      const newText = str(item.newText);
      if (path && newText !== undefined)
        diffs.push({ path, oldText: str(item.oldText) ?? null, newText });
    } else if (item.type === "content") {
      const block = item.content;
      if (isRecord(block) && block.type === "text" && typeof block.text === "string")
        texts.push(block.text);
    } else if (item.type === "terminal") {
      const meta = isRecord(item._meta) ? item._meta : undefined;
      const output =
        meta && isRecord(meta.terminal_output) ? str(meta.terminal_output.data) : undefined;
      if (output) texts.push(output);
    }
  }
  return {
    ...(diffs.length > 0 ? { diffs } : {}),
    ...(texts.length > 0 ? { text: texts.join("\n") } : {}),
  };
}

function rawOutputText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  return undefined;
}

function toolStatusOf(
  value: unknown,
): "pending" | "in_progress" | "completed" | "failed" | undefined {
  const s = str(value);
  return s && TOOL_STATUSES.has(s)
    ? (s as "pending" | "in_progress" | "completed" | "failed")
    : undefined;
}

function buildToolUpdate(
  update: Json,
  toolCallId: string,
  parent: string | undefined,
): EngineEvent | undefined {
  const status = toolStatusOf(update.status);
  const title = str(update.title);
  const content = toolContentOf(update.content);
  const text = content.text ?? rawOutputText(update.rawOutput);
  const hasInput = "rawInput" in update && update.rawInput !== undefined;
  if (!status && !title && !content.diffs && text === undefined && !hasInput) return undefined;
  return withParent(
    {
      kind: "tool_update",
      toolCallId,
      ...(status ? { status } : {}),
      ...(title ? { title } : {}),
      ...(hasInput ? { input: update.rawInput } : {}),
      ...(content.diffs ? { diffs: content.diffs } : {}),
      ...(text !== undefined ? { text } : {}),
    },
    parent,
  );
}

function mapToolCall(
  update: Json,
  memory: ToolCallMemory,
  parent: string | undefined,
): MappedUpdate {
  const toolCallId = str(update.toolCallId);
  if (!toolCallId) return { events: [], ignored: "tool_call 缺少 toolCallId" };
  // 同一 toolCallId 重复的 tool_call 视为更新，避免 UI 出现两张卡片。
  if (memory.names.has(toolCallId)) {
    const ev = buildToolUpdate(update, toolCallId, parent);
    return { events: ev ? [ev] : [] };
  }
  const toolName = toolNameOf(update, memory, toolCallId);
  const input = update.rawInput ?? {};
  memory.names.set(toolCallId, toolName);
  memory.inputs.set(toolCallId, input);
  const kind = str(update.kind);
  const locations = locationsOf(update.locations);
  const start = withParent<EngineEvent>(
    {
      kind: "tool_start",
      toolCallId,
      toolName,
      title: str(update.title) || toolName,
      ...(kind ? { toolKind: kind } : {}),
      input,
      ...(locations ? { locations } : {}),
    },
    parent,
  );
  const events: EngineEvent[] = [start];
  // tool_call 本身就带了结果/预览（diff、文本或非 pending 状态）时，紧跟一条 tool_update。
  const content = toolContentOf(update.content);
  const status = toolStatusOf(update.status);
  if (content.diffs || content.text !== undefined || (status && status !== "pending")) {
    events.push(
      withParent<EngineEvent>(
        {
          kind: "tool_update",
          toolCallId,
          ...(status ? { status } : {}),
          ...(content.diffs ? { diffs: content.diffs } : {}),
          ...(content.text !== undefined ? { text: content.text } : {}),
        },
        parent,
      ),
    );
  }
  return { events };
}

function mapPlan(update: Json): MappedUpdate {
  if (!Array.isArray(update.entries)) return { events: [], ignored: "plan 缺少 entries" };
  const entries: { content: string; status: "pending" | "in_progress" | "completed" }[] = [];
  for (const entry of update.entries) {
    if (!isRecord(entry)) continue;
    const content = str(entry.content);
    if (content === undefined) continue;
    const s = str(entry.status);
    entries.push({
      content,
      status:
        s && PLAN_STATUSES.has(s) ? (s as "pending" | "in_progress" | "completed") : "pending",
    });
  }
  return { events: [{ kind: "plan", entries }] };
}

/**
 * usage_update：ACP 标准形状是上下文占用 `{ used, size, cost }`，不是本回合的 token 用量，
 * 直接当 inputTokens 会和回合末 PromptResponse.usage 重复累计。所以只有带显式 token 字段
 * （inputTokens/outputTokens/...，部分智能体会这样发）时才映射；本回合 token 以 promptUsageEvent 为准。
 */
function mapUsageUpdate(update: Json): MappedUpdate {
  const event = usageEventOf(update);
  return event
    ? { events: [event] }
    : { events: [], ignored: "usage_update 仅含上下文占用（used/size）" };
}

function usageEventOf(value: Json): EngineEvent | undefined {
  const inputTokens = num(value.inputTokens);
  const outputTokens = num(value.outputTokens);
  const cachedTokens = num(value.cachedReadTokens) ?? num(value.cachedTokens);
  if (inputTokens === undefined && outputTokens === undefined && cachedTokens === undefined)
    return undefined;
  return {
    kind: "usage",
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cachedTokens !== undefined ? { cachedTokens } : {}),
  };
}

function mapCommands(update: Json): MappedUpdate {
  if (!Array.isArray(update.availableCommands))
    return { events: [], ignored: "available_commands_update 缺少列表" };
  const commands: { name: string; description: string }[] = [];
  for (const cmd of update.availableCommands) {
    if (!isRecord(cmd)) continue;
    const name = str(cmd.name);
    if (!name) continue;
    commands.push({ name, description: str(cmd.description) ?? "" });
  }
  return { events: [{ kind: "commands", commands }] };
}

function mapNotice(update: Json): MappedUpdate {
  const title = str(update.title) ?? str(update.message);
  if (!title) return { events: [], ignored: "notice 缺少 title" };
  const description = str(update.description);
  return {
    events: [{ kind: "notice", message: description ? `${title}：${description}` : title }],
  };
}

function mapChunk(
  update: Json,
  kind: "text" | "thought",
  parent: string | undefined,
): MappedUpdate {
  const content = update.content;
  if (!isRecord(content) || content.type !== "text" || typeof content.text !== "string") {
    return { events: [], ignored: `${kind} chunk 非文本内容` };
  }
  return { events: [withParent<EngineEvent>({ kind, delta: content.text }, parent)] };
}

/** 把一条 session/update 的 `update` 字段映射成 0..n 个中性事件。 */
export function mapSessionUpdate(update: unknown, memory: ToolCallMemory): MappedUpdate {
  if (!isRecord(update)) return { events: [], ignored: "update 不是对象" };
  const parent = parentToolCallIdOf(update);
  const type = str(update.sessionUpdate);
  switch (type) {
    case "agent_message_chunk":
      return mapChunk(update, "text", parent);
    case "agent_thought_chunk":
      return mapChunk(update, "thought", parent);
    case "tool_call":
      return mapToolCall(update, memory, parent);
    case "tool_call_update": {
      const toolCallId = str(update.toolCallId);
      if (!toolCallId) return { events: [], ignored: "tool_call_update 缺少 toolCallId" };
      const ev = buildToolUpdate(update, toolCallId, parent);
      return ev ? { events: [ev] } : { events: [], ignored: "tool_call_update 无可映射字段" };
    }
    case "plan":
      return mapPlan(update);
    case "usage_update":
      return mapUsageUpdate(update);
    case "current_mode_update": {
      const modeId = str(update.currentModeId);
      return modeId
        ? { events: [{ kind: "mode", modeId }] }
        : { events: [], ignored: "current_mode_update 缺少 currentModeId" };
    }
    case "available_commands_update":
      return mapCommands(update);
    case "notice":
      return mapNotice(update);
    default:
      return { events: [], ignored: `未处理的 sessionUpdate 类型：${type ?? "<缺失>"}` };
  }
}

/** 回合末 PromptResponse.usage（本回合累计 token）→ usage 事件。 */
export function promptUsageEvent(response: unknown): EngineEvent | undefined {
  if (!isRecord(response) || !isRecord(response.usage)) return undefined;
  return usageEventOf(response.usage);
}

/** ACP stopReason → TurnResult.stopReason；未知值按 end_turn 处理（回合确实结束了）。 */
export function mapStopReason(value: unknown): TurnResult["stopReason"] {
  const s = str(value);
  return s && STOP_REASONS.has(s) ? (s as TurnResult["stopReason"]) : "end_turn";
}

/** session/request_permission 的原始参数 → PermissionRequest。 */
export function mapPermissionRequest(params: unknown, memory: ToolCallMemory): PermissionRequest {
  const p = isRecord(params) ? params : {};
  const toolCall = isRecord(p.toolCall) ? p.toolCall : {};
  const toolCallId = str(toolCall.toolCallId) ?? "";
  const toolName = toolNameOf(toolCall, memory, toolCallId);
  const options: PermissionRequest["options"] = [];
  if (Array.isArray(p.options)) {
    for (const option of p.options) {
      if (!isRecord(option)) continue;
      const optionId = str(option.optionId);
      const kind = str(option.kind);
      if (!optionId || !kind || !PERMISSION_KINDS.has(kind)) continue;
      options.push({
        optionId,
        name: str(option.name) ?? optionId,
        kind: kind as PermissionRequest["options"][number]["kind"],
      });
    }
  }
  return {
    toolCallId,
    toolName,
    title: str(toolCall.title) || toolName,
    input: toolCall.rawInput ?? memory.inputs.get(toolCallId) ?? {},
    options,
  };
}
