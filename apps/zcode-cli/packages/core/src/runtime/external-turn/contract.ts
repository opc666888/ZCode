/**
 * 外部回合引擎挂点契约（acp-bridge，docs/acp-bridge/DESIGN.md §5）。
 *
 * Core 不依赖任何 ACP 包：这里的事件/权限类型与 `@zcode/acp-engine` 的 EngineEvent /
 * PermissionRequest / PermissionDecision 结构一致（结构类型，bootstrap 可直接透传）。
 * 引擎由装配层（bootstrap）注入；Core 只负责把中性事件翻译成 ZCode 会话事件并落库。
 */
import type { ModelSelection } from "@zcode/contracts";

export type ExternalToolStatus = "pending" | "in_progress" | "completed" | "failed";

export type ExternalTurnEvent =
  | { kind: "text"; delta: string; parentToolCallId?: string }
  | { kind: "thought"; delta: string; parentToolCallId?: string }
  | {
      kind: "tool_start";
      toolCallId: string;
      toolName: string;
      title: string;
      toolKind?: string;
      input: unknown;
      locations?: { path: string; line?: number }[];
      parentToolCallId?: string;
    }
  | {
      kind: "tool_update";
      toolCallId: string;
      status?: ExternalToolStatus;
      title?: string;
      input?: unknown;
      diffs?: { path: string; oldText: string | null; newText: string }[];
      text?: string;
      parentToolCallId?: string;
    }
  | {
      kind: "plan";
      entries: { content: string; status: "pending" | "in_progress" | "completed" }[];
    }
  | { kind: "usage"; inputTokens?: number; outputTokens?: number; cachedTokens?: number }
  | { kind: "mode"; modeId: string }
  | { kind: "commands"; commands: { name: string; description: string }[] }
  | { kind: "notice"; message: string };

export interface ExternalPermissionRequest {
  toolCallId: string;
  toolName: string;
  title: string;
  input: unknown;
  options: {
    optionId: string;
    name: string;
    kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
  }[];
}

export type ExternalPermissionDecision = { optionId: string } | { cancelled: true };

/** 引擎回调宿主：事件按到达顺序串行处理；权限请求阻塞到用户作答或回合取消。 */
export interface ExternalTurnHost {
  emit(event: ExternalTurnEvent): void | Promise<void>;
  requestPermission(request: ExternalPermissionRequest): Promise<ExternalPermissionDecision>;
}

export interface ExternalTurnInput {
  sessionId: string;
  cwd: string;
  /** 本轮冻结的会话选择（providerId 形如 `acp:<agentId>`）。 */
  selection: ModelSelection;
  prompt: string;
  images?: { mimeType: string; data: string }[];
  signal: AbortSignal;
}

export interface ExternalTurnOutcome {
  stopReason: "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled" | "error";
  error?: string;
  text: string;
  toolCallCount: number;
}

/**
 * 运行时依赖：`AgentRuntimeDeps.externalTurnEngine`。
 * `handles` 为 false 时回合走上游 runRegularTurnLoop，行为与未注入完全一致。
 */
export interface ExternalTurnEngineAdapter {
  handles(selection: ModelSelection | undefined): boolean;
  runTurn(input: ExternalTurnInput, host: ExternalTurnHost): Promise<ExternalTurnOutcome>;
}
