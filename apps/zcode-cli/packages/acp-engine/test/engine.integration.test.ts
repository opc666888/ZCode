/**
 * 集成测试：真实 spawn 假智能体（test/fake-agent.mjs），走 stdio + ACP SDK 2.4.0，不调用真实 Claude。
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CANCEL_TIMEOUT_MS, createAcpEngineWithOptions } from "../src/engine.js";
import { createAcpEngine } from "../src/index.js";
import type {
  AcpAgentConfig,
  AcpEngine,
  EngineEvent,
  PermissionDecision,
  PermissionRequest,
  TurnHost,
} from "../src/types.js";
import { FAKE_AGENT, makeTempDir, removeDir } from "./helpers.js";

interface LogEntry {
  pid: number;
  method: string;
  [key: string]: unknown;
}

interface Recorder extends TurnHost {
  events: EngineEvent[];
  permissions: PermissionRequest[];
}

function recorder(
  decide: (req: PermissionRequest) => Promise<PermissionDecision> = async (req) => ({
    optionId: req.options[0]!.optionId,
  }),
  onEvent?: (ev: EngineEvent) => void,
): Recorder {
  const events: EngineEvent[] = [];
  const permissions: PermissionRequest[] = [];
  return {
    events,
    permissions,
    emit(ev) {
      events.push(ev);
      onEvent?.(ev);
    },
    requestPermission(req) {
      permissions.push(req);
      return decide(req);
    },
  };
}

describe("AcpEngine × fake agent", () => {
  let base: string;
  let cwd: string;
  let stateDir: string;
  let logFile: string;
  let agent: AcpAgentConfig;
  const engines: AcpEngine[] = [];
  const engineLogs: string[] = [];

  function makeEngine(cancelTimeoutMs?: number): AcpEngine {
    const engine = createAcpEngineWithOptions({
      stateDir,
      log: (m) => engineLogs.push(m),
      cancelTimeoutMs,
    });
    engines.push(engine);
    return engine;
  }

  async function agentLog(): Promise<LogEntry[]> {
    if (!existsSync(logFile)) return [];
    return (await readFile(logFile, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as LogEntry);
  }

  function turn(
    prompt: string,
    extra: {
      signal?: AbortSignal;
      modelId?: string;
      zcodeSessionId?: string;
      images?: { mimeType: string; data: string }[];
    } = {},
  ) {
    return {
      zcodeSessionId: extra.zcodeSessionId ?? "z-1",
      cwd,
      agent,
      prompt,
      signal: extra.signal ?? new AbortController().signal,
      ...(extra.modelId ? { modelId: extra.modelId } : {}),
      ...(extra.images ? { images: extra.images } : {}),
    };
  }

  beforeEach(async () => {
    base = await makeTempDir("engine");
    cwd = join(base, "work");
    stateDir = join(base, "state");
    logFile = join(base, "agent.log");
    await mkdir(cwd, { recursive: true });
    await writeFile(join(cwd, "a.txt"), "line1\nline2\nline3\n");
    agent = {
      id: "fake",
      name: "Fake",
      command: process.execPath,
      args: [FAKE_AGENT],
      env: { FAKE_AGENT_LOG: logFile, FAKE_AGENT_STATE: join(base, "fake-state") },
    };
    engineLogs.length = 0;
  });

  afterEach(async () => {
    await Promise.all(engines.splice(0).map((e) => e.dispose()));
    await removeDir(base);
  });

  it("完整一轮：文本/思考/工具（含 diff）/plan/子智能体/commands/mode/notice/usage，并声明 subagent-transcript", async () => {
    const engine = makeEngine();
    const host = recorder();
    const result = await engine.runTurn(turn("full"), host);

    expect(result).toEqual({ stopReason: "end_turn", text: "你好，完成。", toolCallCount: 4 });
    const ev = host.events;
    expect(ev[0]).toEqual({ kind: "thought", delta: "先想一想" });
    expect(ev[1]).toEqual({ kind: "text", delta: "你好，" });
    expect(ev).toContainEqual({
      kind: "tool_start",
      toolCallId: "t-read",
      toolName: "Read",
      title: "Read a.txt",
      toolKind: "read",
      input: { file_path: join(cwd, "a.txt") },
      locations: [{ path: join(cwd, "a.txt"), line: 1 }],
    });
    expect(ev).toContainEqual({
      kind: "tool_update",
      toolCallId: "t-read",
      status: "completed",
      text: "文件内容",
    });
    expect(ev).toContainEqual({
      kind: "tool_update",
      toolCallId: "t-edit",
      status: "in_progress",
      diffs: [{ path: join(cwd, "a.txt"), oldText: "old\n", newText: "new\n" }],
    });
    expect(ev).toContainEqual({
      kind: "tool_update",
      toolCallId: "t-edit",
      status: "completed",
      diffs: [{ path: join(cwd, "b.txt"), oldText: null, newText: "created\n" }],
    });
    expect(ev).toContainEqual({
      kind: "plan",
      entries: [
        { content: "读文件", status: "completed" },
        { content: "改文件", status: "in_progress" },
      ],
    });
    // 子智能体：Agent 工具本身无 parent，其内部事件都挂在 t-agent 下。
    expect(ev).toContainEqual(
      expect.objectContaining({
        kind: "tool_start",
        toolCallId: "t-agent",
        toolName: "Agent",
        toolKind: "think",
      }),
    );
    expect(ev).toContainEqual({ kind: "text", delta: "子智能体正文", parentToolCallId: "t-agent" });
    expect(ev).toContainEqual(
      expect.objectContaining({
        kind: "tool_start",
        toolCallId: "t-sub-grep",
        toolName: "Grep",
        parentToolCallId: "t-agent",
      }),
    );
    expect(ev).toContainEqual({
      kind: "tool_update",
      toolCallId: "t-sub-grep",
      status: "completed",
      text: "a.txt:1:x",
      parentToolCallId: "t-agent",
    });
    expect(ev).toContainEqual({
      kind: "tool_update",
      toolCallId: "t-agent",
      status: "completed",
      text: "子智能体总结",
    });
    expect(ev).toContainEqual({
      kind: "commands",
      commands: [{ name: "review", description: "Review code" }],
    });
    expect(ev).toContainEqual({ kind: "mode", modeId: "acceptEdits" });
    expect(ev).toContainEqual({ kind: "notice", message: "提示：测试通知" });
    // 本回合 token 来自 PromptResponse.usage，且是最后一个事件；usage_update(used/size) 不产生事件。
    expect(ev.at(-1)).toEqual({
      kind: "usage",
      inputTokens: 100,
      outputTokens: 50,
      cachedTokens: 30,
    });
    expect(ev.filter((e) => e.kind === "usage")).toHaveLength(1);
    // 事件顺序：tool_start 一定在同一工具的 tool_update 之前。
    const idx = (pred: (e: EngineEvent) => boolean) => ev.findIndex(pred);
    expect(idx((e) => e.kind === "tool_start" && e.toolCallId === "t-agent")).toBeLessThan(
      idx((e) => e.kind === "text" && e.parentToolCallId === "t-agent"),
    );
    expect(ev.at(-2)).toEqual({ kind: "text", delta: "完成。" });

    const log = await agentLog();
    const init = log.find((e) => e.method === "initialize");
    expect(init?.clientCapabilities).toMatchObject({
      fs: { readTextFile: true, writeTextFile: true },
      terminal: false,
      _meta: { "subagent-transcript": true },
    });
    const created = log.find((e) => e.method === "session/new");
    const mapping = JSON.parse(await readFile(join(stateDir, "sessions.json"), "utf8"));
    expect(mapping.sessions["z-1"]).toMatchObject({
      agentId: "fake",
      acpSessionId: created?.sessionId,
    });
    // 日志里不出现 env 的值。
    expect(engineLogs.join("\n")).not.toContain(logFile);
  });

  it("同一会话第二轮复用进程，不重新 initialize；图片作为 image 块发送", async () => {
    const engine = makeEngine();
    await engine.runTurn(turn("hello"), recorder());
    const r2 = await engine.runTurn(
      turn("again", { images: [{ mimeType: "image/png", data: "aGk=" }] }),
      recorder(),
    );
    expect(r2.text).toBe("echo:again images=1");
    const log = await agentLog();
    expect(log.filter((e) => e.method === "initialize")).toHaveLength(1);
    expect(log.filter((e) => e.method === "session/new")).toHaveLength(1);
    expect(new Set(log.map((e) => e.pid)).size).toBe(1);
  });

  it("权限允许：按 optionId 回给智能体，智能体经 fs/write_text_file 写入工作区", async () => {
    const engine = makeEngine();
    const host = recorder(async () => ({ optionId: "allow-once" }));
    const result = await engine.runTurn(turn("edit"), host);
    expect(result).toMatchObject({ stopReason: "end_turn", text: "已修改", toolCallCount: 1 });
    expect(host.permissions).toEqual([
      {
        toolCallId: "t-edit",
        toolName: "Edit",
        title: "Edit edit-target.txt",
        input: { file_path: join(cwd, "edit-target.txt"), content: "edited\n" },
        options: [
          { optionId: "allow-once", name: "Allow", kind: "allow_once" },
          { optionId: "allow-always", name: "Always Allow", kind: "allow_always" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      },
    ]);
    // 弹权限前，对应的 tool_start 已经交给宿主。
    expect(host.events[0]).toMatchObject({ kind: "tool_start", toolCallId: "t-edit" });
    expect(await readFile(join(cwd, "edit-target.txt"), "utf8")).toBe("edited\n");
    expect(host.events).toContainEqual({
      kind: "tool_update",
      toolCallId: "t-edit",
      status: "completed",
      diffs: [{ path: join(cwd, "edit-target.txt"), oldText: null, newText: "edited\n" }],
    });
    expect((await agentLog()).find((e) => e.method === "permission-outcome")?.outcome).toEqual({
      outcome: "selected",
      optionId: "allow-once",
    });
  });

  it("权限拒绝：工具失败，文件不被写入", async () => {
    const engine = makeEngine();
    const host = recorder(async () => ({ optionId: "reject" }));
    const result = await engine.runTurn(turn("edit"), host);
    expect(result).toMatchObject({ stopReason: "end_turn", text: "已拒绝" });
    expect(host.events).toContainEqual({
      kind: "tool_update",
      toolCallId: "t-edit",
      status: "failed",
      text: "User refused",
    });
    expect(existsSync(join(cwd, "edit-target.txt"))).toBe(false);
  });

  it("宿主回 cancelled：权限按 cancelled 回给智能体", async () => {
    const engine = makeEngine();
    const controller = new AbortController();
    const host = recorder(async () => {
      setTimeout(() => controller.abort(), 10);
      return { cancelled: true };
    });
    const result = await engine.runTurn(turn("edit", { signal: controller.signal }), host);
    expect(result.stopReason).toBe("cancelled");
    expect((await agentLog()).find((e) => e.method === "permission-outcome")?.outcome).toEqual({
      outcome: "cancelled",
    });
  });

  it("取消：等待权限时中止，未决权限回 cancelled，回合 5 秒内以 cancelled 结束", async () => {
    const engine = makeEngine();
    const controller = new AbortController();
    const host = recorder(() => {
      setTimeout(() => controller.abort(), 20);
      return new Promise<PermissionDecision>(() => {});
    });
    const started = Date.now();
    const result = await engine.runTurn(turn("edit", { signal: controller.signal }), host);
    expect(result.stopReason).toBe("cancelled");
    expect(Date.now() - started).toBeLessThan(DEFAULT_CANCEL_TIMEOUT_MS);
    const log = await agentLog();
    expect(log.find((e) => e.method === "permission-outcome")?.outcome).toEqual({
      outcome: "cancelled",
    });
    expect(log.some((e) => e.method === "session/cancel")).toBe(true);
  });

  it("取消：智能体配合时发 session/cancel 并很快回 cancelled，进程保留可继续下一轮", async () => {
    const engine = makeEngine();
    const controller = new AbortController();
    const host = recorder(undefined, (ev) => {
      if (ev.kind === "text") controller.abort();
    });
    const started = Date.now();
    const result = await engine.runTurn(turn("hang", { signal: controller.signal }), host);
    expect(result).toMatchObject({ stopReason: "cancelled", text: "开始" });
    expect(Date.now() - started).toBeLessThan(DEFAULT_CANCEL_TIMEOUT_MS);
    const next = await engine.runTurn(turn("after"), recorder());
    expect(next.text).toBe("echo:after");
    const log = await agentLog();
    expect(log.filter((e) => e.method === "session/cancel")).toHaveLength(1);
    expect(new Set(log.map((e) => e.pid)).size).toBe(1);
  });

  it("取消：智能体不理会时默认 5 秒超时杀进程并返回 cancelled，下一轮 session/load 恢复", async () => {
    expect(DEFAULT_CANCEL_TIMEOUT_MS).toBe(5000);
    const engine = createAcpEngine({ stateDir });
    engines.push(engine);
    const controller = new AbortController();
    const host = recorder(undefined, (ev) => {
      if (ev.kind === "text") controller.abort();
    });
    const started = Date.now();
    const result = await engine.runTurn(
      turn("hang-ignore-cancel", { signal: controller.signal }),
      host,
    );
    const elapsed = Date.now() - started;
    expect(result.stopReason).toBe("cancelled");
    expect(elapsed).toBeGreaterThanOrEqual(DEFAULT_CANCEL_TIMEOUT_MS - 50);
    expect(elapsed).toBeLessThan(DEFAULT_CANCEL_TIMEOUT_MS + 1500);
    const next = await engine.runTurn(turn("after-kill"), recorder());
    expect(next.text).toBe("echo:after-kill");
    const log = await agentLog();
    expect(new Set(log.map((e) => e.pid)).size).toBe(2);
    expect(log.some((e) => e.method === "session/load")).toBe(true);
  }, 15000);

  it("进程崩溃：本轮返回 error；下一轮重新 initialize + session/load，回放的历史不进入事件", async () => {
    const engine = makeEngine();
    const crashHost = recorder();
    const crashed = await engine.runTurn(turn("crash"), crashHost);
    expect(crashed.stopReason).toBe("error");
    expect(crashed.error).toContain("code=3");
    expect(crashed.text).toBe("即将崩溃");

    const host = recorder();
    const result = await engine.runTurn(turn("recovered"), host);
    expect(result).toMatchObject({ stopReason: "end_turn", text: "echo:recovered" });
    expect(host.events).toEqual([{ kind: "text", delta: "echo:recovered" }]);

    const log = await agentLog();
    const created = log.find((e) => e.method === "session/new");
    const loaded = log.find((e) => e.method === "session/load");
    expect(loaded?.sessionId).toBe(created?.sessionId);
    expect(log.filter((e) => e.method === "initialize")).toHaveLength(2);
    expect(log.filter((e) => e.method === "session/new")).toHaveLength(1);
    expect(new Set(log.map((e) => e.pid)).size).toBe(2);
  });

  it("引擎重建（CLI 重启）后按 sessions.json 用 session/load 恢复", async () => {
    const first = makeEngine();
    await first.runTurn(turn("one"), recorder());
    await first.dispose();
    const second = makeEngine();
    const result = await second.runTurn(turn("two"), recorder());
    expect(result.text).toBe("echo:two");
    const log = await agentLog();
    expect(log.filter((e) => e.method === "session/load")).toHaveLength(1);
    expect(log.filter((e) => e.method === "session/new")).toHaveLength(1);
  });

  it("session/load 失败（智能体找不到会话）时新建会话并发 notice", async () => {
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      join(stateDir, "sessions.json"),
      JSON.stringify({
        version: 1,
        sessions: { "z-1": { agentId: "fake", acpSessionId: "fake-missing", updatedAt: "" } },
      }),
    );
    const engine = makeEngine();
    const host = recorder();
    const result = await engine.runTurn(turn("hi"), host);
    expect(result.text).toBe("echo:hi");
    expect(host.events[0]).toEqual({
      kind: "notice",
      message: "无法恢复之前的 ACP 会话上下文，已新建会话",
    });
    const log = await agentLog();
    expect(log.map((e) => e.method)).toEqual([
      "initialize",
      "session/load",
      "session/new",
      "session/prompt",
    ]);
  });

  it("智能体不支持 loadSession 时重连走 session/new", async () => {
    agent = { ...agent, env: { ...agent.env, FAKE_AGENT_NO_LOAD: "1" } };
    const engine = makeEngine();
    await engine.runTurn(turn("crash"), recorder());
    await engine.runTurn(turn("again"), recorder());
    const log = await agentLog();
    expect(log.some((e) => e.method === "session/load")).toBe(false);
    expect(log.filter((e) => e.method === "session/new")).toHaveLength(2);
  });

  it("模型：default 不设置；指定模型用 set_config_option(model) 且不重复；失败只发 notice", async () => {
    const engine = makeEngine();
    await engine.runTurn(turn("a", { modelId: "default" }), recorder());
    await engine.runTurn(turn("b", { modelId: "opus" }), recorder());
    await engine.runTurn(turn("c", { modelId: "opus" }), recorder());
    const host = recorder();
    const r = await engine.runTurn(turn("d", { modelId: "bad-model" }), host);
    expect(r).toMatchObject({ stopReason: "end_turn", text: "echo:d" });
    expect(host.events[0]).toEqual({
      kind: "notice",
      message: "切换模型「bad-model」失败，继续使用当前模型",
    });
    const sets = (await agentLog()).filter((e) => e.method === "session/set_config_option");
    expect(sets.map((e) => [e.configId, e.value])).toEqual([
      ["model", "opus"],
      ["model", "bad-model"],
    ]);
  });

  it("文件能力只允许工作区内路径", async () => {
    const engine = makeEngine();
    const result = await engine.runTurn(turn("fs-outside"), recorder());
    expect(result.text).toBe("outside=denied inside=line2");
  });

  it("启动失败返回 error 而不抛出；已中止的 signal 直接返回 cancelled；并发回合被拒绝", async () => {
    const engine = makeEngine();
    agent = { ...agent, command: join(base, "no-such-binary") };
    const failed = await engine.runTurn(turn("x"), recorder());
    expect(failed.stopReason).toBe("error");
    expect(failed.error).toContain("无法启动");

    const aborted = new AbortController();
    aborted.abort();
    expect(await engine.runTurn(turn("x", { signal: aborted.signal }), recorder())).toEqual({
      stopReason: "cancelled",
      text: "",
      toolCallCount: 0,
    });

    agent = { ...agent, command: process.execPath };
    const controller = new AbortController();
    const running = engine.runTurn(
      turn("hang", { signal: controller.signal, zcodeSessionId: "z-2" }),
      recorder(),
    );
    const busy = await engine.runTurn(turn("x", { zcodeSessionId: "z-2" }), recorder());
    expect(busy.stopReason).toBe("error");
    controller.abort();
    expect((await running).stopReason).toBe("cancelled");
  });

  it("disposeSession 结束进程但保留映射", async () => {
    const engine = makeEngine();
    await engine.runTurn(turn("x"), recorder());
    const pid = (await agentLog())[0]!.pid;
    await engine.disposeSession("z-1");
    expect(() => process.kill(pid, 0)).toThrow();
    const mapping = JSON.parse(await readFile(join(stateDir, "sessions.json"), "utf8"));
    expect(mapping.sessions["z-1"]).toBeTruthy();
  });
});
