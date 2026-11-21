/**
 * 外部智能体派出的子智能体（Claude Code 的 Agent/Task 工具）→ ZCode 子会话。
 *
 * 子会话与 Core 原生 subagent 同形：独立 sessionId（`sess_subagent_*`）、parentID 指向父会话、
 * 事件写共享 event store 并经父 runtime 的 sinks 转发（bootstrap 按 event.sessionId 路由到
 * child publisher，UI 订阅 conversation/<childSessionId> 即可下钻）。父会话只收到
 * SubagentSpawned / SubagentMessage / SubagentStopped 三个生命周期事实。
 */
import { createHash } from "node:crypto";
import type { MessageId, ModelSelection, SessionEvent, TraceContext } from "@zcode/contracts";
import { AgentRuntime } from "../agent-runtime.js";
import {
  SessionEventType,
  createChildTraceContext,
  createMessageId,
  createModelUsageSummaryFromEvents,
  createSessionId,
  createTurnId,
} from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { ExternalTranscriptWriter } from "./transcript-writer.js";

const SUBAGENT_TOOL_NAMES = new Set(["Agent", "Task"]);

export function isExternalSubagentToolName(toolName: string): boolean {
  return SUBAGENT_TOOL_NAMES.has(toolName);
}

function readString(input: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = input?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function safeIdPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
}

export class ExternalChildSession {
  readonly writer: ExternalTranscriptWriter;
  readonly childSessionId: string;
  /** 写进父工具 part 的 metadata：冷恢复（transcript-hydration）据此还原 childSessionId。 */
  get toolMetadata(): Record<string, unknown> {
    return {
      agentId: this.lifecycle.agentId,
      agentType: this.lifecycle.agentType,
      childSessionId: this.childSessionId,
      description: this.lifecycle.description,
    };
  }
  #stopped = false;

  private constructor(
    private readonly parent: AgentRuntimeInternal,
    private readonly child: AgentRuntimeInternal & { retire(): Promise<void>; close(): Promise<void> },
    private readonly lifecycle: {
      agentId: string;
      executionId: string;
      agentType: string;
      description: string;
      parentToolCallId: string;
      parentTrace: TraceContext;
      parentEvents: SessionEvent[];
      childTrace: TraceContext;
      childEvents: SessionEvent[];
      startedAt: number;
    },
    writer: ExternalTranscriptWriter,
  ) {
    this.writer = writer;
    this.childSessionId = child.sessionId;
  }

  static async spawn(
    parent: AgentRuntimeInternal,
    options: {
      parentToolCallId: string;
      input: Record<string, unknown> | undefined;
      selection: ModelSelection;
      parentTrace: TraceContext;
      parentEvents: SessionEvent[];
    },
  ): Promise<ExternalChildSession> {
    // 子会话 id 必须按「父会话 + 工具调用」唯一：外部智能体的 toolCallId 只在自己的会话内唯一，
    // 只用 toolCallId 会让不同父会话撞进同一个子会话（smoke 复跑时内容叠加即此因）。
    // 仍保持确定性，以便重连回放同一工具调用时落回同一子会话。
    const scope = createHash("sha256")
      .update(`${parent.sessionId}\u0000${options.parentToolCallId}`)
      .digest("hex")
      .slice(0, 16);
    const agentId = `agent_acp_${safeIdPart(options.parentToolCallId).slice(0, 40)}_${scope}`;
    const childSessionId = createSessionId(`subagent_${agentId}`);
    const agentType = readString(options.input, "subagent_type") ?? "general-purpose";
    const prompt = readString(options.input, "prompt") ?? "";
    const description = readString(options.input, "description") ?? (prompt.slice(0, 80) || agentType);
    const childTurnId = createTurnId();
    const childTrace = createChildTraceContext(options.parentTrace, {
      sessionId: childSessionId,
      rootSessionId: options.parentTrace.rootSessionId ?? parent.sessionId,
      turnId: childTurnId,
      attributes: { agentId, agentType, parentSessionId: parent.sessionId },
    });
    const child = new AgentRuntime(
      childSessionId,
      {
        agentName: "zcode-acp-subagent",
        workingDirectory: parent.workingDirectory,
        workspacePath: parent.config.workspacePath ?? parent.workspaceRoot,
        ...(parent.config.workspaceIdentity
          ? { workspaceIdentity: parent.config.workspaceIdentity }
          : {}),
        ...(parent.config.workspaceKey ? { workspaceKey: parent.config.workspaceKey } : {}),
        modelSelection: options.selection,
        parentSessionId: parent.sessionId,
        taskType: "subagent_child",
        subagents: { enabled: false },
        titleGeneration: { enabled: false },
      },
      {
        eventStore: parent.eventStore,
        ...(parent.sessionStore ? { sessionStore: parent.sessionStore } : {}),
        modelFactory: parent.modelFactory,
        permissionBroker: parent.permissionBroker,
        appVersion: parent.appVersion,
        ...(parent.logger ? { logger: parent.logger } : {}),
        traceContext: childTrace,
        eventSink: {
          // 子事件已按 childSessionId 落库；这里只通知父 runtime 的外部 sinks，不再 append。
          onSessionEvent: async (event) => {
            await parent.notifyEventSinks(event, { ...childTrace, sessionId: childSessionId });
          },
        },
      },
    ) as unknown as AgentRuntimeInternal & { retire(): Promise<void>; close(): Promise<void> };
    // 与原生 subagent 相同：先落库子会话，再发布 SubagentSpawned，目录查询不会少一个 child。
    await child.ensureSessionPersistedForExternalActivity(prompt || description, {
      traceContext: childTrace,
    });
    const executionId = crypto.randomUUID();
    const startedAt = Date.now();
    const spawned = parent.createEvent(
      SessionEventType.SubagentSpawned,
      {
        agentId,
        taskId: agentId,
        executionId,
        agentType,
        childSessionId,
        description,
        prompt,
        parentToolCallId: options.parentToolCallId,
        status: "running",
        model: `${options.selection.providerId}/${options.selection.modelId}`,
      },
      options.parentTrace,
    );
    await parent.appendEvent(spawned, options.parentTrace);
    options.parentEvents.push(spawned);

    const childEvents: SessionEvent[] = [];
    const userMessageId: MessageId = createMessageId();
    const turnStarted = child.createEvent(
      SessionEventType.TurnStarted,
      {
        executionStartedAt: startedAt,
        turnNumber: child.turnNumber,
        input: prompt || description,
        messageId: userMessageId,
        inputSource: "subagent",
      },
      childTrace,
    );
    await child.appendEvent(turnStarted, childTrace);
    childEvents.push(turnStarted);
    await child.persistUserPrompt(userMessageId, prompt || description, undefined, childTrace, {
      inputPresentation: "coordinator_input",
    });
    const writer = new ExternalTranscriptWriter({
      runtime: child,
      parentMessageId: userMessageId,
      traceContext: childTrace,
      events: childEvents,
      querySource: "subagent",
    });
    return new ExternalChildSession(
      parent,
      child,
      {
        agentId,
        executionId,
        agentType,
        description,
        parentToolCallId: options.parentToolCallId,
        parentTrace: options.parentTrace,
        parentEvents: options.parentEvents,
        childTrace,
        childEvents,
        startedAt,
      },
      writer,
    );
  }

  get stopped(): boolean {
    return this.#stopped;
  }

  /** 子会话收口：子 TurnComplete → 父 SubagentMessage(摘要) → 父 SubagentStopped。幂等。 */
  async stop(status: "completed" | "failed" | "cancelled", error?: string): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    const { child, lifecycle } = this;
    const cancelled = status === "cancelled";
    try {
      await this.writer.finish({
        cancelled,
        ...(status === "failed" ? { error: error ?? "Subagent failed" } : {}),
      });
      const complete = child.createEvent(
        SessionEventType.TurnComplete,
        {
          response: this.writer.lastText,
          tokenCount: 0,
          usage: createModelUsageSummaryFromEvents(lifecycle.childEvents),
          toolCallCount: this.writer.toolCallCount,
          duration: Date.now() - lifecycle.startedAt,
          resultType: cancelled ? "cancelled" : "success",
        },
        lifecycle.childTrace,
      );
      await child.appendEvent(complete, lifecycle.childTrace);
      lifecycle.childEvents.push(complete);
      child.turnNumber += 1;
    } finally {
      const summaryText = this.writer.lastText || error || lifecycle.description;
      const base = {
        agentId: lifecycle.agentId,
        taskId: lifecycle.agentId,
        executionId: lifecycle.executionId,
        agentType: lifecycle.agentType,
        childSessionId: this.childSessionId,
        parentToolCallId: lifecycle.parentToolCallId,
      };
      for (const [type, payload] of [
        [SessionEventType.SubagentMessage, { ...base, summaryText }],
        [SessionEventType.SubagentStopped, { ...base, status, summaryText }],
      ] as const) {
        const event = this.parent.createEvent(type, payload, lifecycle.parentTrace);
        await this.parent.appendEvent(event, lifecycle.parentTrace);
        lifecycle.parentEvents.push(event);
      }
      try {
        await (cancelled ? child.close() : child.retire());
      } catch (releaseError) {
        this.parent.logger?.warn("ACP child session release failed", {
          event: "acp_bridge.child_release.failed",
          module: "core.runtime.external_turn",
          errorMessage: releaseError instanceof Error ? releaseError.message : String(releaseError),
        });
      }
    }
  }
}
