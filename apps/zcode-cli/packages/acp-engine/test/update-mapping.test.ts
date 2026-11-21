import { describe, expect, it } from "vitest";
import {
  createToolCallMemory,
  mapPermissionRequest,
  mapSessionUpdate,
  mapStopReason,
  parentToolCallIdOf,
  promptUsageEvent,
} from "../src/update-mapping.js";

const sub = (parent: string, toolName?: string) => ({
  _meta: { claudeCode: { ...(toolName ? { toolName } : {}), parentToolUseId: parent } },
});

describe("mapSessionUpdate", () => {
  it("agent_message_chunk → text，透传 parentToolUseId", () => {
    const m = createToolCallMemory();
    expect(
      mapSessionUpdate(
        { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } },
        m,
      ).events,
    ).toEqual([{ kind: "text", delta: "hi" }]);
    expect(
      mapSessionUpdate(
        {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "sub" },
          ...sub("t1"),
        },
        m,
      ).events,
    ).toEqual([{ kind: "text", delta: "sub", parentToolCallId: "t1" }]);
  });

  it("agent_thought_chunk → thought；非文本内容被忽略", () => {
    const m = createToolCallMemory();
    expect(
      mapSessionUpdate(
        { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } },
        m,
      ).events,
    ).toEqual([{ kind: "thought", delta: "hmm" }]);
    const img = mapSessionUpdate(
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "image", data: "x", mimeType: "image/png" },
      },
      m,
    );
    expect(img.events).toEqual([]);
    expect(img.ignored).toBeTruthy();
  });

  it("tool_call → tool_start：toolName 取 _meta.claudeCode.toolName，locations/kind/input 透传", () => {
    const m = createToolCallMemory();
    const out = mapSessionUpdate(
      {
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        title: "Read a.txt",
        kind: "read",
        status: "pending",
        locations: [{ path: "/w/a.txt", line: 3 }, { path: "/w/b.txt" }, { nope: 1 }],
        rawInput: { file_path: "/w/a.txt" },
        _meta: { claudeCode: { toolName: "Read" } },
      },
      m,
    );
    expect(out.events).toEqual([
      {
        kind: "tool_start",
        toolCallId: "t1",
        toolName: "Read",
        title: "Read a.txt",
        toolKind: "read",
        input: { file_path: "/w/a.txt" },
        locations: [{ path: "/w/a.txt", line: 3 }, { path: "/w/b.txt" }],
      },
    ]);
  });

  it("tool_call 没有 _meta 时 toolName 退回 name，再退回 title", () => {
    const m = createToolCallMemory();
    expect(
      mapSessionUpdate({ sessionUpdate: "tool_call", toolCallId: "a", title: "T", name: "bash" }, m)
        .events[0],
    ).toMatchObject({
      toolName: "bash",
      input: {},
    });
    expect(
      mapSessionUpdate({ sessionUpdate: "tool_call", toolCallId: "b", title: "Some Title" }, m)
        .events[0],
    ).toMatchObject({
      toolName: "Some Title",
      title: "Some Title",
    });
  });

  it("tool_call 自带 diff / 非 pending 状态时追加一条 tool_update", () => {
    const m = createToolCallMemory();
    const out = mapSessionUpdate(
      {
        sessionUpdate: "tool_call",
        toolCallId: "e1",
        title: "Edit",
        status: "in_progress",
        content: [{ type: "diff", path: "/w/a", oldText: "o", newText: "n" }],
        _meta: { claudeCode: { toolName: "Edit" } },
      },
      m,
    );
    expect(out.events).toHaveLength(2);
    expect(out.events[1]).toEqual({
      kind: "tool_update",
      toolCallId: "e1",
      status: "in_progress",
      diffs: [{ path: "/w/a", oldText: "o", newText: "n" }],
    });
  });

  it("重复的 tool_call 视为更新，不再发 tool_start", () => {
    const m = createToolCallMemory();
    mapSessionUpdate(
      {
        sessionUpdate: "tool_call",
        toolCallId: "d",
        title: "X",
        _meta: { claudeCode: { toolName: "Bash" } },
      },
      m,
    );
    const again = mapSessionUpdate(
      { sessionUpdate: "tool_call", toolCallId: "d", title: "X2", status: "in_progress" },
      m,
    );
    expect(again.events).toEqual([
      { kind: "tool_update", toolCallId: "d", status: "in_progress", title: "X2" },
    ]);
  });

  it("tool_call_update：diff 进 diffs（oldText 缺省为 null），content/terminal 文本拼成 text", () => {
    const m = createToolCallMemory();
    const out = mapSessionUpdate(
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        status: "completed",
        content: [
          { type: "diff", path: "/w/new.txt", newText: "x" },
          { type: "content", content: { type: "text", text: "line1" } },
          { type: "terminal", terminalId: "term", _meta: { terminal_output: { data: "out" } } },
          { type: "content", content: { type: "image", data: "", mimeType: "image/png" } },
        ],
        ...sub("parent", "Edit"),
      },
      m,
    );
    expect(out.events).toEqual([
      {
        kind: "tool_update",
        toolCallId: "t1",
        status: "completed",
        diffs: [{ path: "/w/new.txt", oldText: null, newText: "x" }],
        text: "line1\nout",
        parentToolCallId: "parent",
      },
    ]);
  });

  it("tool_call_update：无 content 时用字符串 rawOutput 作 text；rawInput 透传；未知状态丢弃", () => {
    const m = createToolCallMemory();
    expect(
      mapSessionUpdate(
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "t",
          status: "weird",
          rawOutput: "res",
          rawInput: { a: 1 },
        },
        m,
      ).events,
    ).toEqual([{ kind: "tool_update", toolCallId: "t", input: { a: 1 }, text: "res" }]);
    const empty = mapSessionUpdate({ sessionUpdate: "tool_call_update", toolCallId: "t" }, m);
    expect(empty.events).toEqual([]);
    expect(mapSessionUpdate({ sessionUpdate: "tool_call_update" }, m).ignored).toContain(
      "toolCallId",
    );
  });

  it("plan → plan，未知状态按 pending", () => {
    const m = createToolCallMemory();
    expect(
      mapSessionUpdate(
        {
          sessionUpdate: "plan",
          entries: [
            { content: "a", priority: "high", status: "completed" },
            { content: "b", priority: "low", status: "blocked" },
            { nope: true },
          ],
        },
        m,
      ).events,
    ).toEqual([
      {
        kind: "plan",
        entries: [
          { content: "a", status: "completed" },
          { content: "b", status: "pending" },
        ],
      },
    ]);
  });

  it("usage_update：只有显式 token 字段才映射；上下文占用 used/size 不当成 token", () => {
    const m = createToolCallMemory();
    const ctx = mapSessionUpdate({ sessionUpdate: "usage_update", used: 100, size: 1000 }, m);
    expect(ctx.events).toEqual([]);
    expect(ctx.ignored).toContain("used/size");
    expect(
      mapSessionUpdate(
        {
          sessionUpdate: "usage_update",
          used: 1,
          size: 2,
          inputTokens: 5,
          outputTokens: 6,
          cachedReadTokens: 7,
        },
        m,
      ).events,
    ).toEqual([{ kind: "usage", inputTokens: 5, outputTokens: 6, cachedTokens: 7 }]);
  });

  it("current_mode_update → mode；available_commands_update → commands；notice → notice", () => {
    const m = createToolCallMemory();
    expect(
      mapSessionUpdate({ sessionUpdate: "current_mode_update", currentModeId: "plan" }, m).events,
    ).toEqual([{ kind: "mode", modeId: "plan" }]);
    expect(
      mapSessionUpdate(
        {
          sessionUpdate: "available_commands_update",
          availableCommands: [{ name: "init", description: "Init" }, { name: "x" }, {}],
        },
        m,
      ).events,
    ).toEqual([
      {
        kind: "commands",
        commands: [
          { name: "init", description: "Init" },
          { name: "x", description: "" },
        ],
      },
    ]);
    expect(
      mapSessionUpdate(
        { sessionUpdate: "notice", severity: "warning", title: "额度", description: "快用完了" },
        m,
      ).events,
    ).toEqual([{ kind: "notice", message: "额度：快用完了" }]);
    expect(
      mapSessionUpdate({ sessionUpdate: "notice", severity: "info", title: "仅标题" }, m).events,
    ).toEqual([{ kind: "notice", message: "仅标题" }]);
  });

  it("未知类型、user_message_chunk、非对象输入只返回 ignored", () => {
    const m = createToolCallMemory();
    for (const u of [
      { sessionUpdate: "session_info_update", title: "t" },
      { sessionUpdate: "user_message_chunk", content: { type: "text", text: "u" } },
      { sessionUpdate: "subagent_update" },
      {},
      null,
      "str",
    ]) {
      const out = mapSessionUpdate(u, m);
      expect(out.events).toEqual([]);
      expect(out.ignored).toBeTruthy();
    }
  });
});

describe("其他映射", () => {
  it("parentToolCallIdOf 只认 _meta.claudeCode.parentToolUseId 字符串", () => {
    expect(parentToolCallIdOf(sub("p"))).toBe("p");
    expect(
      parentToolCallIdOf({ _meta: { claudeCode: { parentToolUseId: null } } }),
    ).toBeUndefined();
    expect(parentToolCallIdOf({})).toBeUndefined();
  });

  it("promptUsageEvent 读取 PromptResponse.usage", () => {
    expect(
      promptUsageEvent({
        stopReason: "end_turn",
        usage: { totalTokens: 9, inputTokens: 1, outputTokens: 2, cachedReadTokens: 3 },
      }),
    ).toEqual({
      kind: "usage",
      inputTokens: 1,
      outputTokens: 2,
      cachedTokens: 3,
    });
    expect(promptUsageEvent({ stopReason: "end_turn" })).toBeUndefined();
    expect(promptUsageEvent(null)).toBeUndefined();
  });

  it("mapStopReason：已知值原样，未知值按 end_turn", () => {
    for (const s of ["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled"])
      expect(mapStopReason(s)).toBe(s);
    expect(mapStopReason("something_new")).toBe("end_turn");
    expect(mapStopReason(undefined)).toBe("end_turn");
  });

  it("mapPermissionRequest：工具名/入参优先取请求，其次取之前 tool_call 记住的值；丢弃未知 kind", () => {
    const m = createToolCallMemory();
    mapSessionUpdate(
      {
        sessionUpdate: "tool_call",
        toolCallId: "t9",
        title: "Edit x",
        rawInput: { file_path: "/w/x" },
        _meta: { claudeCode: { toolName: "Edit" } },
      },
      m,
    );
    expect(
      mapPermissionRequest(
        {
          sessionId: "s",
          toolCall: { toolCallId: "t9", title: "Edit x" },
          options: [
            { optionId: "allow-once", name: "Allow", kind: "allow_once" },
            { optionId: "allow-with-updates", name: "Always", kind: "allow_always" },
            { optionId: "reject", name: "Reject", kind: "reject_once" },
            { optionId: "weird", name: "?", kind: "custom" },
          ],
        },
        m,
      ),
    ).toEqual({
      toolCallId: "t9",
      toolName: "Edit",
      title: "Edit x",
      input: { file_path: "/w/x" },
      options: [
        { optionId: "allow-once", name: "Allow", kind: "allow_once" },
        { optionId: "allow-with-updates", name: "Always", kind: "allow_always" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
    });
    expect(mapPermissionRequest({}, createToolCallMemory())).toEqual({
      toolCallId: "",
      toolName: "tool",
      title: "tool",
      input: {},
      options: [],
    });
  });
});
