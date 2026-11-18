/**
 * ACP Bridge 引擎对外契约（见 docs/acp-bridge/DESIGN.md §4.1）。
 * 本文件是 W1（acp-engine 实现）与 W2（运行时适配器）之间的接口，改动需主控同意。
 */
export interface AcpAgentConfig { id: string; name: string; command: string; args?: string[]; env?: Record<string,string>; models?: string[] }

export type EngineEvent =
  | { kind: "text"; delta: string; parentToolCallId?: string }
  | { kind: "thought"; delta: string; parentToolCallId?: string }
  | { kind: "tool_start"; toolCallId: string; toolName: string; title: string; toolKind?: string;
      input: unknown; locations?: { path: string; line?: number }[]; parentToolCallId?: string }
  | { kind: "tool_update"; toolCallId: string; status?: "pending"|"in_progress"|"completed"|"failed";
      title?: string; input?: unknown; diffs?: { path: string; oldText: string | null; newText: string }[];
      text?: string; parentToolCallId?: string }
  | { kind: "plan"; entries: { content: string; status: "pending"|"in_progress"|"completed" }[] }
  | { kind: "usage"; inputTokens?: number; outputTokens?: number; cachedTokens?: number }
  | { kind: "mode"; modeId: string }
  | { kind: "commands"; commands: { name: string; description: string }[] }
  | { kind: "notice"; message: string };

export interface PermissionRequest {
  toolCallId: string; toolName: string; title: string; input: unknown;
  options: { optionId: string; name: string; kind: "allow_once"|"allow_always"|"reject_once"|"reject_always" }[];
}
export type PermissionDecision = { optionId: string } | { cancelled: true };

export interface TurnHost {
  emit(ev: EngineEvent): void | Promise<void>;
  requestPermission(req: PermissionRequest): Promise<PermissionDecision>;
}

export interface TurnInput {
  zcodeSessionId: string; cwd: string; agent: AcpAgentConfig; modelId?: string;
  prompt: string; images?: { mimeType: string; data: string }[]; signal: AbortSignal;
}
export interface TurnResult {
  stopReason: "end_turn"|"max_tokens"|"max_turn_requests"|"refusal"|"cancelled"|"error";
  error?: string; text: string; toolCallCount: number;
}

export interface AcpEngine {
  runTurn(input: TurnInput, host: TurnHost): Promise<TurnResult>;
  disposeSession(zcodeSessionId: string): Promise<void>;
  dispose(): Promise<void>;
}
export interface CreateAcpEngineOptions { stateDir: string; log?: (msg: string) => void }
export type CreateAcpEngine = (opts: CreateAcpEngineOptions) => AcpEngine;
export type LoadAcpAgents = (dataBaseDir: string) => AcpAgentConfig[];
