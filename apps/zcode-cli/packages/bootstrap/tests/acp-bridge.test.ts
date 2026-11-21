// acp-bridge CLI 层验收（docs/acp-bridge/DESIGN.md §5、§8）：
// 真 sqlite sessionStore + ZCodeProtocolAgentServer + 真 app，外部回合由 stub 引擎或
// W1 的真实 acp-engine + fake-agent.mjs 驱动（不调用任何真实模型）。
// 覆盖：事件序列、消息库落库、v4 投影（正文/工具 diff/plan/子智能体可下钻/availability）、
// 权限桥、stop 中止、冷恢复，以及无配置时普通会话不受影响。
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import { createAcpEngine } from "@zcode/acp-engine";
import { zcodeProtocolMethods, type ZCodeProtocolMessage } from "@zcode/shared";
import {
  V4_METHODS,
  V4_NOTIFICATIONS,
  commandAckSchema,
  conversationSnapshotSchema,
  conversationTopic,
  routedTopicWireFrameSchema,
  type ConversationSnapshot,
} from "@zcode/shared/zcode-protocol-v4";
import type { SessionEvent, SessionEventStorePort, SessionId } from "@zcode/contracts";
import { ZCodeProtocolAgentServer } from "../src/zcode-protocol/server.js";
import type { ZCodeApp } from "../src/app/types.js";
import {
  createAcpBridge,
  loadProcessAcpBridge,
  type AcpBridge,
  type AcpBridgeEngine,
  type AcpBridgeEngineEvent,
  type AcpBridgeTurnHost,
  type AcpBridgeTurnInput,
} from "../src/acp-bridge/index.js";
import {
  createRegistryBackedTestApp,
  createTestProviderRegistry,
} from "./helpers/registry-backed-test-app.js";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_AGENT = join(here, "../../acp-engine/test/fake-agent.mjs");
const NORMAL_MODEL = { providerId: "zai", modelId: "glm-4.6" };
const ACP_MODEL = { providerId: "acp:fake", modelId: "default" };
const NORMAL_ANSWER = "normal model answer";
const SUITE_TIMEOUT_MS = 60_000;
const WAIT_TIMEOUT_MS = 20_000;
const ISSUED_AT = 1_700_000_000_000;

type TurnHandler = (input: AcpBridgeTurnInput, host: AcpBridgeTurnHost) => Promise<{
  stopReason: "end_turn" | "cancelled" | "error";
  text: string;
  toolCallCount: number;
  error?: string;
}>;

/** stub 引擎：每轮按顺序取一个脚本执行，记录输入。 */
function createStubEngine(scripts: TurnHandler[]) {
  const inputs: AcpBridgeTurnInput[] = [];
  const disposed: string[] = [];
  const engine: AcpBridgeEngine = {
    async runTurn(input, host) {
      inputs.push(input);
      const script = scripts.shift();
      if (!script) throw new Error("stub engine: no script left");
      return script(input, host);
    },
    async disposeSession(sessionId) {
      disposed.push(sessionId);
    },
    async dispose() {},
  };
  return { engine, inputs, disposed };
}

async function bootServer(input: {
  root: string;
  dbPath: string;
  acpBridge: AcpBridge | null | undefined;
}) {
  const store = await createSqliteSessionStore({ dbPath: input.dbPath });
  const apps: ZCodeApp[] = [];
  const eventStores: SessionEventStorePort[] = [];
  const env = { ZCODE_DATA_BASE_DIR: input.root };
  const providerRegistry = createTestProviderRegistry([NORMAL_MODEL]);
  let normalModelCalls = 0;
  const server = new ZCodeProtocolAgentServer({
    cwd: input.root,
    env,
    sessionStore: store,
    createZCodeApp: async (options = {}) => {
      if (options.eventStore) eventStores.push(options.eventStore);
      const app = await createRegistryBackedTestApp({
        ...options,
        runtimeConfig: { ...options.runtimeConfig, mcp: { enabled: false } },
        env,
        skipUserConfig: true,
        providerRegistry,
        acpBridge: input.acpBridge,
        modelExecutor: {
          async generateText() {
            normalModelCalls += 1;
            return {
              finishReason: "stop" as const,
              text: NORMAL_ANSWER,
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
          async *streamText() {
            normalModelCalls += 1;
            yield { type: "text_delta" as const, text: NORMAL_ANSWER };
            yield { type: "finish" as const, finishReason: "stop" as const, usage: {} };
          },
        },
      });
      apps.push(app);
      return app;
    },
  });
  server.setNotificationSink((message) => {
    if (!("id" in message)) return;
    if (message.method === zcodeProtocolMethods.sessionRequestRuntimePreferences) {
      void server.handleMessage({
        id: message.id,
        result: { nativeSearchEnhancementsEnabled: false, memoryEnabled: false },
      });
    }
  });
  return {
    server,
    store,
    apps,
    normalModelCalls: () => normalModelCalls,
    async events(sessionId: string): Promise<SessionEvent[]> {
      for (const eventStore of eventStores) {
        const events = await eventStore.getEvents(sessionId as SessionId);
        if (events.length > 0) return events;
      }
      return [];
    },
    close: async () => {
      await server.shutdown();
      server.disposeProjections();
      for (const app of apps) await app.close?.();
      store.close();
    },
  };
}

type Booted = Awaited<ReturnType<typeof bootServer>>;

async function requestResult(server: ZCodeProtocolAgentServer, message: ZCodeProtocolMessage) {
  const response = await server.handleMessage(message);
  if (!response || !("result" in response)) {
    throw new Error(`Expected protocol success response: ${JSON.stringify(response)}`);
  }
  return response.result;
}

function command(id: string, type: string, payload: Record<string, unknown>, sessionId: string | null = null) {
  return {
    id,
    method: V4_METHODS.command,
    params: {
      commandId: id,
      clientId: "client-acp-bridge",
      sessionId,
      type,
      payload,
      issuedAt: ISSUED_AT,
    },
  } as ZCodeProtocolMessage;
}

async function snapshotOf(booted: Booted, sessionId: string): Promise<ConversationSnapshot> {
  const id = `subscribe-${sessionId}-${Math.random()}`;
  await requestResult(booted.server, {
    id,
    method: V4_METHODS.conversationSubscribe,
    params: {
      topic: conversationTopic(sessionId),
      connectionId: id,
      clientMode: "desktop-continuous",
    },
  } as ZCodeProtocolMessage);
  const frameMessage = booted.server
    .takePostResponseMessages(id)
    .find((message) => "method" in message && message.method === V4_NOTIFICATIONS.conversationFrame);
  if (!frameMessage) throw new Error("Expected an initial conversation frame");
  const wire = routedTopicWireFrameSchema.parse((frameMessage as { params: unknown }).params);
  if (wire.kind !== "complete") throw new Error("Expected one complete physical wire");
  const frame = wire.frame as { payload: { kind: string; snapshot?: unknown } };
  if (frame.payload.kind !== "snapshot") throw new Error("Expected conversation snapshot");
  return conversationSnapshotSchema.parse(frame.payload.snapshot);
}

async function waitFor<T>(read: () => Promise<T>, predicate: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  for (;;) {
    const value = await read();
    if (predicate(value)) return value;
    if (Date.now() > deadline) throw new Error(`waitFor timed out: ${JSON.stringify(value).slice(0, 2000)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function turnStates(snapshot: ConversationSnapshot) {
  return snapshot.rows.window.flatMap((row) => (row.kind === "turnHeader" ? [row.state] : []));
}

function rowsOf<K extends string>(snapshot: ConversationSnapshot, kind: K) {
  return snapshot.rows.window.filter((row) => row.kind === kind) as Extract<
    ConversationSnapshot["rows"]["window"][number],
    { kind: K }
  >[];
}

async function createAcpSession(booted: Booted, workspace: string, text: string): Promise<string> {
  const created = commandAckSchema.parse(
    await requestResult(
      booted.server,
      command(`create-${Math.random()}`, "createSession", {
        workspaceId: workspace,
        firstInput: { text, modelSelection: ACP_MODEL },
      }),
    ),
  );
  expect(created.status).toBe("accepted");
  if (created.result?.type !== "createSession") throw new Error("Expected createSession");
  return created.result.sessionId;
}

/** 与 fake-agent.mjs 的 `full` 剧本同形：正文 / 思考 / 工具 diff / plan / 子智能体 / usage。 */
const fullScript =
  (cwd: () => string): TurnHandler =>
  async (_input, host) => {
    const emit = async (event: AcpBridgeEngineEvent) => host.emit(event);
    await emit({ kind: "thought", delta: "先想一想" });
    await emit({ kind: "text", delta: "你好，" });
    await emit({
      kind: "tool_start",
      toolCallId: "t-edit",
      toolName: "Edit",
      title: "Edit a.txt",
      input: { file_path: join(cwd(), "a.txt"), old_string: "old", new_string: "new" },
    });
    await emit({
      kind: "tool_update",
      toolCallId: "t-edit",
      status: "completed",
      diffs: [{ path: join(cwd(), "a.txt"), oldText: "old\n", newText: "new\n" }],
    });
    await emit({
      kind: "plan",
      entries: [
        { content: "读文件", status: "completed" },
        { content: "改文件", status: "in_progress" },
      ],
    });
    await emit({ kind: "tool_start", toolCallId: "t-agent", toolName: "Agent", title: "Explore", input: {} });
    await emit({
      kind: "tool_update",
      toolCallId: "t-agent",
      input: { description: "Explore codebase", prompt: "find x", subagent_type: "Explore" },
    });
    await emit({ kind: "text", delta: "子智能体正文", parentToolCallId: "t-agent" });
    await emit({
      kind: "tool_start",
      toolCallId: "t-sub-grep",
      toolName: "Grep",
      title: "grep x",
      input: { pattern: "x" },
      parentToolCallId: "t-agent",
    });
    await emit({
      kind: "tool_update",
      toolCallId: "t-sub-grep",
      status: "completed",
      text: "a.txt:1:x",
      parentToolCallId: "t-agent",
    });
    await emit({ kind: "tool_update", toolCallId: "t-agent", status: "completed", text: "子智能体总结" });
    await emit({ kind: "commands", commands: [{ name: "review", description: "Review code" }] });
    await emit({ kind: "text", delta: "完成。" });
    await emit({ kind: "usage", inputTokens: 100, outputTokens: 50, cachedTokens: 30 });
    return { stopReason: "end_turn", text: "完成。", toolCallCount: 3 };
  };

function expectAcpSessionGated(snapshot: ConversationSnapshot) {
  for (const key of ["fork", "compact", "rewindFiles", "pauseGoal", "resumeGoal"] as const) {
    expect(snapshot.availability[key]).toMatchObject({ allowed: false, reasonCode: "acpAgentSessionUnsupported" });
  }
  expect(snapshot.availability.switchModelConfig).toMatchObject({ allowed: true });
  for (const row of snapshot.rows.window) {
    const actions = (row as { actions?: Record<string, unknown> }).actions ?? {};
    for (const key of ["canFork", "canEdit", "canRetry", "canRewindFiles"]) {
      expect(actions[key] === undefined || actions[key] === false, `${row.kind}.${key}`).toBe(true);
    }
  }
}

/** 一轮完整 ACP 回合在父/子会话投影里的样子；live 与冷恢复共用同一组断言。 */
async function expectFullTurnProjection(booted: Booted, sessionId: string, editPath: string) {
  const snapshot = await snapshotOf(booted, sessionId);
  expect(snapshot.config.provider).toBe("acp:fake");
  expect(turnStates(snapshot)).toEqual(["completedSuccess"]);
  const texts = rowsOf(snapshot, "assistantText").map((row) => row.text);
  expect(texts).toEqual(["你好，", "完成。"]);
  expect(rowsOf(snapshot, "reasoning").map((row) => row.text)).toEqual(["先想一想"]);

  const tools = rowsOf(snapshot, "toolCall");
  const edit = tools.find((row) => row.toolCallId === "t-edit");
  expect(edit).toMatchObject({ toolName: "Edit", status: "success" });
  expect(JSON.stringify(edit?.display ?? edit?.output)).toContain(editPath);
  expect(JSON.stringify(edit?.display ?? edit?.output)).toContain("+new");
  // 子智能体内部工具不进父时间线。
  expect(tools.some((row) => row.toolCallId === "t-sub-grep")).toBe(false);
  expect(tools.some((row) => row.toolName === "TodoWrite")).toBe(true);

  expect(snapshot.plan?.items.map((item) => [item.content, item.status])).toEqual([
    ["读文件", "completed"],
    ["改文件", "inProgress"],
  ]);

  const subagents = rowsOf(snapshot, "subagent");
  expect(subagents).toHaveLength(1);
  const subagent = subagents[0]!;
  expect(subagent).toMatchObject({ parentToolCallId: "t-agent", subagentType: "Explore", status: "success" });
  expect(subagent.childSessionId).toMatch(/^sess_subagent_agent_acp_t-agent/);
  expectAcpSessionGated(snapshot);

  const child = await snapshotOf(booted, subagent.childSessionId!);
  expect(rowsOf(child, "assistantText").map((row) => row.text)).toEqual(["子智能体正文"]);
  expect(rowsOf(child, "toolCall").map((row) => [row.toolCallId, row.toolName, row.status])).toEqual([
    ["t-sub-grep", "Grep", "success"],
  ]);
  return { snapshot, childSessionId: subagent.childSessionId! };
}

describe("acp-bridge：外部 ACP 智能体驱动 ZCode 会话", { timeout: SUITE_TIMEOUT_MS }, () => {
  let root: string;
  let project: string;

  beforeEach(async () => {
    const base = process.env.ZCODE_ACP_TEST_TMPDIR ?? tmpdir();
    await mkdir(base, { recursive: true });
    root = await realpath(await mkdtemp(join(base, "zcode-acp-bridge-")));
    project = join(root, "project");
    await mkdir(project, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it("stub 引擎：事件序列、消息库落库、v4 投影与冷恢复", async () => {
    const stub = createStubEngine([fullScript(() => project)]);
    const bridge = createAcpBridge({
      agents: [{ id: "fake", name: "Fake ACP", command: "unused", models: ["default", "opus"] }],
      engine: stub.engine,
    })!;
    const dbPath = join(root, "flow.db");
    const live = await bootServer({ root, dbPath, acpBridge: bridge });
    let sessionId = "";
    let childSessionId = "";
    try {
      sessionId = await createAcpSession(live, project, "full please");
      await waitFor(
        () => snapshotOf(live, sessionId),
        (snapshot) => turnStates(snapshot).includes("completedSuccess"),
      );
      // 引擎拿到的是 agent 配置与原始 prompt；`default` 模型不下发 modelId。
      expect(stub.inputs).toHaveLength(1);
      expect(stub.inputs[0]).toMatchObject({ zcodeSessionId: sessionId, cwd: project, prompt: "full please" });
      expect(stub.inputs[0]!.agent.id).toBe("fake");
      expect(stub.inputs[0]!.modelId).toBeUndefined();
      expect(live.normalModelCalls()).toBe(0);

      ({ childSessionId } = await expectFullTurnProjection(live, sessionId, join(project, "a.txt")));

      // 父会话事件序列：TurnStarted → 流式 → 工具 → plan(TodoWrite) → 子智能体生命周期 → TurnComplete。
      const types = (await live.events(sessionId)).map((event) => event.type as string);
      const order = [
        "turn_started",
        "model_streaming",
        "tool_call_scheduled",
        "tool_call_result",
        "subagent_spawned",
        "subagent_message",
        "subagent_stopped",
        "turn_complete",
      ];
      const indices = order.map((type) => types.indexOf(type));
      expect(indices.every((index) => index >= 0), types.join(",")).toBe(true);
      expect([...indices].sort((a, b) => a - b)).toEqual(indices);
      const complete = (await live.events(sessionId)).find((event) => event.type === "turn_complete");
      expect(complete?.payload).toMatchObject({
        resultType: "success",
        response: "完成。",
        usage: expect.objectContaining({ inputTokens: 100, outputTokens: 50 }),
      });

      // 消息库：assistant 文本/思考/工具 part 都已落库（冷恢复靠它合成）。
      const messages = await live.store.messages({ sessionID: sessionId as SessionId });
      const parts = messages.filter((message) => message.info.role === "assistant").flatMap((m) => m.parts);
      expect(parts.filter((part) => part.type === "text").map((part) => (part as { text: string }).text)).toEqual([
        "你好，",
        "完成。",
      ]);
      expect(parts.some((part) => part.type === "reasoning")).toBe(true);
      const editPart = parts.find((part) => part.type === "tool" && part.callID === "t-edit") as
        | { state: { status: string; metadata?: { display?: { kind: string } } } }
        | undefined;
      expect(editPart?.state.status).toBe("completed");
      expect(editPart?.state.metadata?.display?.kind).toBe("file_diff");
      const childMessages = await live.store.messages({ sessionID: childSessionId as SessionId });
      expect(childMessages.some((message) => message.parts.some((part) => part.type === "tool"))).toBe(true);
    } finally {
      await live.close();
    }

    // 冷恢复：关库重开（内存注册表为空），从消息库合成的投影与 live 一致。
    const cold = await bootServer({ root, dbPath, acpBridge: bridge });
    try {
      await expectFullTurnProjection(cold, sessionId, join(project, "a.txt"));
    } finally {
      await cold.close();
    }
  });

  it("stub 引擎：权限请求经 PermissionBroker 进入 pendingInteractions，作答映射回 ACP optionId", async () => {
    const decisions: unknown[] = [];
    const stub = createStubEngine([
      async (_input, host) => {
        await host.emit({ kind: "tool_start", toolCallId: "t-edit", toolName: "Edit", title: "Edit x", input: { file_path: "x" } });
        const decision = await host.requestPermission({
          toolCallId: "t-edit",
          toolName: "Edit",
          title: "Edit x",
          input: { file_path: "x" },
          options: [
            { optionId: "allow-once", name: "Allow", kind: "allow_once" },
            { optionId: "allow-always", name: "Always", kind: "allow_always" },
            { optionId: "reject", name: "Reject", kind: "reject_once" },
          ],
        });
        decisions.push(decision);
        await host.emit({ kind: "tool_update", toolCallId: "t-edit", status: "completed" });
        await host.emit({ kind: "text", delta: "done" });
        return { stopReason: "end_turn", text: "done", toolCallCount: 1 };
      },
    ]);
    const bridge = createAcpBridge({ agents: [{ id: "fake", name: "Fake", command: "unused" }], engine: stub.engine })!;
    const booted = await bootServer({ root, dbPath: join(root, "perm.db"), acpBridge: bridge });
    try {
      const sessionId = await createAcpSession(booted, project, "edit please");
      const pending = await waitFor(
        () => snapshotOf(booted, sessionId),
        (snapshot) => snapshot.pendingInteractions.length > 0,
      );
      const interaction = pending.pendingInteractions[0]!;
      expect(interaction.payload).toMatchObject({ kind: "permission", toolCallId: "t-edit", toolName: "Edit" });
      const options = (interaction.payload as { options: { optionId: string; kind: string }[] }).options;
      const allowOnce = options.find((option) => option.kind === "allowOnce");
      expect(allowOnce).toBeDefined();
      const ack = commandAckSchema.parse(
        await requestResult(
          booted.server,
          command(
            "resolve-perm",
            "resolveInteraction",
            { interactionId: interaction.interactionId, answer: { optionId: allowOnce!.optionId } },
            sessionId,
          ),
        ),
      );
      expect(ack.status).toBe("accepted");
      const done = await waitFor(
        () => snapshotOf(booted, sessionId),
        (snapshot) => turnStates(snapshot).includes("completedSuccess"),
      );
      expect(decisions).toEqual([{ optionId: "allow-once" }]);
      expect(done.pendingInteractions).toHaveLength(0);
      const types = (await booted.events(sessionId)).map((event) => event.type as string);
      expect(types).toContain("permission_requested");
      expect(types).toContain("permission_resolved");
    } finally {
      await booted.close();
    }
  });

  it("stub 引擎：stop 触发 turnAbortSignal，引擎收到中止，回合以 cancelled 收尾", async () => {
    let aborted = false;
    const stub = createStubEngine([
      async (input, host) => {
        await host.emit({ kind: "text", delta: "开始" });
        await new Promise<void>((resolve) => {
          if (input.signal.aborted) return resolve();
          input.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        aborted = true;
        return { stopReason: "cancelled", text: "开始", toolCallCount: 0 };
      },
    ]);
    const bridge = createAcpBridge({ agents: [{ id: "fake", name: "Fake", command: "unused" }], engine: stub.engine })!;
    const booted = await bootServer({ root, dbPath: join(root, "stop.db"), acpBridge: bridge });
    try {
      const sessionId = await createAcpSession(booted, project, "hang");
      await waitFor(
        () => snapshotOf(booted, sessionId),
        (snapshot) => rowsOf(snapshot, "assistantText").some((row) => row.text === "开始"),
      );
      const ack = commandAckSchema.parse(await requestResult(booted.server, command("stop-1", "stop", {}, sessionId)));
      expect(ack.status).toBe("accepted");
      const stopped = await waitFor(
        () => snapshotOf(booted, sessionId),
        (snapshot) => turnStates(snapshot).some((state) => state !== "running"),
      );
      expect(aborted).toBe(true);
      expect(turnStates(stopped)).toEqual(["completedInterrupted"]);
      const complete = (await booted.events(sessionId)).find((event) => event.type === "turn_complete");
      expect(complete?.payload).toMatchObject({ resultType: "cancelled" });
    } finally {
      await booted.close();
    }
  });

  it("无 acp-agents.json：不装配 bridge，普通会话照常走模型、availability 不被 ACP 门控", async () => {
    expect(loadProcessAcpBridge({ ZCODE_DATA_BASE_DIR: root })).toBeUndefined();
    await mkdir(join(root, ".zcode"), { recursive: true });
    await writeFile(join(root, ".zcode", "acp-agents.json"), "{ not json");
    expect(loadProcessAcpBridge({ ZCODE_DATA_BASE_DIR: root })).toBeUndefined();
    await writeFile(join(root, ".zcode", "acp-agents.json"), JSON.stringify({ agents: [] }));
    expect(loadProcessAcpBridge({ ZCODE_DATA_BASE_DIR: root })).toBeUndefined();

    // acpBridge 缺省（undefined）走 loadProcessAcpBridge(env)：本 root 下没有有效 agent。
    const booted = await bootServer({ root, dbPath: join(root, "normal.db"), acpBridge: undefined });
    try {
      const created = commandAckSchema.parse(
        await requestResult(
          booted.server,
          command("create-normal", "createSession", {
            workspaceId: project,
            firstInput: { text: "hi", modelSelection: { ...NORMAL_MODEL, options: { reasoningLevel: "medium" } } },
          }),
        ),
      );
      if (created.result?.type !== "createSession") throw new Error("Expected createSession");
      const sessionId = created.result.sessionId;
      const snapshot = await waitFor(
        () => snapshotOf(booted, sessionId),
        (value) => turnStates(value).includes("completedSuccess"),
      );
      expect(rowsOf(snapshot, "assistantText").map((row) => row.text)).toEqual([NORMAL_ANSWER]);
      expect(booted.normalModelCalls()).toBeGreaterThan(0);
      expect(snapshot.availability.fork).not.toMatchObject({ reasonCode: "acpAgentSessionUnsupported" });
      expect(snapshot.availability.compact).not.toMatchObject({ reasonCode: "acpAgentSessionUnsupported" });
      // 未配置时 ACP 选择不被 Registry 接受。
      const rejected = await booted.server.handleMessage(
        command("send-acp", "sendText", { text: "x", modelSelection: ACP_MODEL }, sessionId),
      );
      expect(JSON.stringify(rejected)).not.toContain('"status":"accepted"');
    } finally {
      await booted.close();
    }
  });

  it("端到端：真实 acp-engine + fake-agent.mjs（full / edit 权限 / hang 取消）", async () => {
    const engine = createAcpEngine({ stateDir: join(root, "acp-bridge-state") });
    const bridge = createAcpBridge({
      agents: [
        {
          id: "fake",
          name: "Fake ACP",
          command: process.execPath,
          args: [FAKE_AGENT],
          env: { FAKE_AGENT_STATE: join(root, "fake-agent-state") },
        },
      ],
      engine,
    })!;
    const booted = await bootServer({ root, dbPath: join(root, "e2e.db"), acpBridge: bridge });
    try {
      // full：正文 / 思考 / 工具 diff / plan / 子智能体。
      const sessionId = await createAcpSession(booted, project, "full");
      const snapshot = await waitFor(
        () => snapshotOf(booted, sessionId),
        (value) => turnStates(value).includes("completedSuccess"),
      );
      expect(rowsOf(snapshot, "assistantText").map((row) => row.text).join("")).toContain("完成。");
      expect(rowsOf(snapshot, "reasoning").map((row) => row.text)).toContain("先想一想");
      const edit = rowsOf(snapshot, "toolCall").find((row) => row.toolCallId === "t-edit");
      expect(edit).toMatchObject({ toolName: "Edit", status: "success" });
      expect(JSON.stringify(edit?.display ?? edit?.output)).toContain("file_diff");
      expect(snapshot.plan?.items.map((item) => item.content)).toEqual(["读文件", "改文件"]);
      const subagent = rowsOf(snapshot, "subagent")[0];
      expect(subagent).toMatchObject({ parentToolCallId: "t-agent", subagentType: "Explore", status: "success" });
      const child = await snapshotOf(booted, subagent!.childSessionId!);
      expect(rowsOf(child, "assistantText").map((row) => row.text)).toEqual(["子智能体正文"]);
      expect(rowsOf(child, "toolCall").map((row) => row.toolName)).toEqual(["Grep"]);
      expectAcpSessionGated(snapshot);
      const complete = (await booted.events(sessionId)).find((event) => event.type === "turn_complete");
      expect(complete?.payload).toMatchObject({ resultType: "success" });

      // edit：权限弹窗 → 允许一次 → 智能体经 fs/write_text_file 写入工作区文件。
      await requestResult(booted.server, command("send-edit", "sendText", { text: "edit", modelSelection: ACP_MODEL }, sessionId));
      const pending = await waitFor(
        () => snapshotOf(booted, sessionId),
        (value) => value.pendingInteractions.length > 0,
      );
      const interaction = pending.pendingInteractions[0]!;
      const options = (interaction.payload as { options: { optionId: string; kind: string }[] }).options;
      await requestResult(
        booted.server,
        command(
          "resolve-edit",
          "resolveInteraction",
          {
            interactionId: interaction.interactionId,
            answer: { optionId: options.find((option) => option.kind === "allowOnce")!.optionId },
          },
          sessionId,
        ),
      );
      const edited = await waitFor(
        () => snapshotOf(booted, sessionId),
        (value) => turnStates(value).filter((state) => state === "completedSuccess").length === 2,
      );
      expect(rowsOf(edited, "assistantText").some((row) => row.text === "已修改")).toBe(true);

      // hang：stop → session/cancel → cancelled。
      await requestResult(booted.server, command("send-hang", "sendText", { text: "hang", modelSelection: ACP_MODEL }, sessionId));
      await waitFor(
        () => snapshotOf(booted, sessionId),
        (value) => turnStates(value).at(-1) === "running" && rowsOf(value, "assistantText").some((row) => row.text === "开始"),
      );
      await requestResult(booted.server, command("stop-hang", "stop", {}, sessionId));
      const stopped = await waitFor(
        () => snapshotOf(booted, sessionId),
        (value) => turnStates(value).length === 3 && turnStates(value).at(-1) !== "running",
      );
      expect(turnStates(stopped).at(-1)).toBe("completedInterrupted");
    } finally {
      await booted.close();
      await engine.dispose();
    }
  });
});
