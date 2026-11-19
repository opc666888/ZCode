#!/usr/bin/env node
/**
 * 测试用假 ACP 智能体（不调用任何真实模型）。用 SDK 2.4.0 的 agent() App API 实现
 * （SDK 2.x 已移除旧的 AgentSideConnection，见其 MIGRATION_STABLE_UNSTABLE.md）。
 *
 * 剧本由 prompt 第一个词决定：
 *   full                文本 / 思考 / 工具调用（含 diff）/ plan / 子智能体（parentToolUseId）/ commands / mode / usage / notice
 *   edit                Edit 工具 + 权限请求；允许则经 fs/write_text_file 写文件，拒绝则工具失败
 *   hang                发一段文本后等 session/cancel，回 cancelled
 *   hang-ignore-cancel  发一段文本后无视取消，永远不返回
 *   crash               发一段文本后进程退出（模拟崩溃）
 *   fs-outside          读工作区外文件（应被拒）和工作区内文件
 *   其他                回显 echo:<prompt>
 *
 * 环境变量：
 *   FAKE_AGENT_LOG    收到的调用逐行写成 JSON（测试据此断言）
 *   FAKE_AGENT_STATE  会话持久化目录（跨进程 session/load 用）
 *   FAKE_AGENT_NO_LOAD=1  不声明 loadSession 能力
 */
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";
import {
  agent,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
} from "@agentclientprotocol/sdk/unstable";

const LOG = process.env.FAKE_AGENT_LOG;
const STATE = process.env.FAKE_AGENT_STATE;
const NO_LOAD = process.env.FAKE_AGENT_NO_LOAD === "1";

function log(entry) {
  if (LOG) appendFileSync(LOG, `${JSON.stringify({ pid: process.pid, ...entry })}\n`);
}

const sessionCwd = new Map();
const cancelWaiters = new Map();

function waitForCancel(sessionId) {
  return new Promise((resolve) => cancelWaiters.set(sessionId, resolve));
}

function sessionFile(sessionId) {
  return STATE ? join(STATE, `${sessionId}.json`) : undefined;
}

const app = agent({ name: "fake-acp-agent" });

app.onRequest("initialize", ({ params }) => {
  log({ method: "initialize", clientCapabilities: params.clientCapabilities });
  return {
    protocolVersion: PROTOCOL_VERSION,
    agentCapabilities: { loadSession: !NO_LOAD },
    authMethods: [],
  };
});

app.onRequest("session/new", ({ params }) => {
  const sessionId = `fake-${randomUUID()}`;
  sessionCwd.set(sessionId, params.cwd);
  const file = sessionFile(sessionId);
  if (file) {
    mkdirSync(STATE, { recursive: true });
    writeFileSync(file, JSON.stringify({ cwd: params.cwd }));
  }
  log({ method: "session/new", sessionId, cwd: params.cwd });
  return { sessionId };
});

app.onRequest("session/load", async ({ params, client }) => {
  log({ method: "session/load", sessionId: params.sessionId });
  const file = sessionFile(params.sessionId);
  if (!file || !existsSync(file)) throw RequestError.resourceNotFound(params.sessionId);
  sessionCwd.set(params.sessionId, params.cwd);
  // 真实智能体在 load 时会回放历史；引擎不应把它当成本回合输出。
  const send = (update) => client.notify("session/update", { sessionId: params.sessionId, update });
  await send({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "历史问题" } });
  await send({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "历史回答" } });
  return {};
});

app.onRequest("session/set_config_option", ({ params }) => {
  log({ method: "session/set_config_option", configId: params.configId, value: params.value });
  if (params.value === "bad-model") throw RequestError.invalidParams(undefined, "unknown model");
  return { configOptions: [] };
});

app.onNotification("session/cancel", ({ params }) => {
  log({ method: "session/cancel", sessionId: params.sessionId });
  cancelWaiters.get(params.sessionId)?.();
});

const claude = (toolName, parent) => ({
  claudeCode: { ...(toolName ? { toolName } : {}), ...(parent ? { parentToolUseId: parent } : {}) },
});

app.onRequest("session/prompt", async ({ params, client }) => {
  const sessionId = params.sessionId;
  const cwd = sessionCwd.get(sessionId) ?? process.cwd();
  const text = params.prompt.find((b) => b.type === "text")?.text ?? "";
  const images = params.prompt.filter((b) => b.type === "image").length;
  log({ method: "session/prompt", sessionId, text, images });
  const send = (update) => client.notify("session/update", { sessionId, update });
  const scenario = text.split(/\s+/)[0];

  if (scenario === "full") {
    await send({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "先想一想" },
    });
    await send({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "你好，" } });
    await send({
      sessionUpdate: "tool_call",
      toolCallId: "t-read",
      title: "Read a.txt",
      kind: "read",
      status: "pending",
      locations: [{ path: join(cwd, "a.txt"), line: 1 }],
      rawInput: { file_path: join(cwd, "a.txt") },
      _meta: claude("Read"),
    });
    await send({
      sessionUpdate: "tool_call_update",
      toolCallId: "t-read",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "文件内容" } }],
    });
    await send({
      sessionUpdate: "tool_call",
      toolCallId: "t-edit",
      title: "Edit a.txt",
      kind: "edit",
      status: "in_progress",
      rawInput: { file_path: join(cwd, "a.txt"), old_string: "old", new_string: "new" },
      content: [{ type: "diff", path: join(cwd, "a.txt"), oldText: "old\n", newText: "new\n" }],
      _meta: claude("Edit"),
    });
    await send({
      sessionUpdate: "tool_call_update",
      toolCallId: "t-edit",
      status: "completed",
      content: [{ type: "diff", path: join(cwd, "b.txt"), oldText: null, newText: "created\n" }],
    });
    await send({
      sessionUpdate: "plan",
      entries: [
        { content: "读文件", priority: "medium", status: "completed" },
        { content: "改文件", priority: "medium", status: "in_progress" },
      ],
    });
    await send({
      sessionUpdate: "tool_call",
      toolCallId: "t-agent",
      title: "Explore codebase",
      kind: "think",
      status: "pending",
      rawInput: { description: "Explore codebase", prompt: "find x", subagent_type: "Explore" },
      _meta: claude("Agent"),
    });
    await send({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "子智能体正文" },
      _meta: claude(undefined, "t-agent"),
    });
    await send({
      sessionUpdate: "tool_call",
      toolCallId: "t-sub-grep",
      title: "grep x",
      kind: "search",
      status: "pending",
      rawInput: { pattern: "x" },
      _meta: claude("Grep", "t-agent"),
    });
    await send({
      sessionUpdate: "tool_call_update",
      toolCallId: "t-sub-grep",
      status: "completed",
      rawOutput: "a.txt:1:x",
      _meta: claude("Grep", "t-agent"),
    });
    await send({
      sessionUpdate: "tool_call_update",
      toolCallId: "t-agent",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "子智能体总结" } }],
      _meta: claude("Agent"),
    });
    await send({
      sessionUpdate: "available_commands_update",
      availableCommands: [{ name: "review", description: "Review code" }],
    });
    await send({ sessionUpdate: "current_mode_update", currentModeId: "acceptEdits" });
    await send({ sessionUpdate: "usage_update", used: 1234, size: 200000 });
    await send({
      sessionUpdate: "notice",
      severity: "info",
      title: "提示",
      description: "测试通知",
    });
    await send({ sessionUpdate: "session_info_update", title: "会话标题" });
    await send({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "完成。" } });
    return {
      stopReason: "end_turn",
      usage: { totalTokens: 180, inputTokens: 100, outputTokens: 50, cachedReadTokens: 30 },
    };
  }

  if (scenario === "edit") {
    const file = join(cwd, "edit-target.txt");
    await send({
      sessionUpdate: "tool_call",
      toolCallId: "t-edit-perm",
      title: "Edit edit-target.txt",
      kind: "edit",
      status: "pending",
      rawInput: { file_path: file, content: "edited\n" },
      _meta: claude("Edit"),
    });
    const cancelled = waitForCancel(sessionId);
    const response = await client.request("session/request_permission", {
      sessionId,
      toolCall: {
        toolCallId: "t-edit-perm",
        title: "Edit edit-target.txt",
        rawInput: { file_path: file, content: "edited\n" },
      },
      options: [
        { optionId: "allow-once", name: "Allow", kind: "allow_once" },
        { optionId: "allow-always", name: "Always Allow", kind: "allow_always" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
    });
    log({ method: "permission-outcome", outcome: response.outcome });
    if (response.outcome.outcome === "cancelled") {
      await cancelled;
      return { stopReason: "cancelled" };
    }
    if (response.outcome.optionId === "reject") {
      await send({
        sessionUpdate: "tool_call_update",
        toolCallId: "t-edit-perm",
        status: "failed",
        rawOutput: "User refused",
      });
      await send({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "已拒绝" },
      });
      return { stopReason: "end_turn" };
    }
    await client.request("fs/write_text_file", { sessionId, path: file, content: "edited\n" });
    await send({
      sessionUpdate: "tool_call_update",
      toolCallId: "t-edit-perm",
      status: "completed",
      content: [{ type: "diff", path: file, oldText: null, newText: "edited\n" }],
    });
    await send({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "已修改" } });
    return { stopReason: "end_turn" };
  }

  if (scenario === "hang") {
    const cancelled = waitForCancel(sessionId);
    await send({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "开始" } });
    await cancelled;
    return { stopReason: "cancelled" };
  }

  if (scenario === "hang-ignore-cancel") {
    await send({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "开始" } });
    return new Promise(() => {});
  }

  if (scenario === "crash") {
    await send({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "即将崩溃" },
    });
    log({ method: "crash" });
    process.exit(3);
  }

  if (scenario === "fs-outside") {
    let outside;
    try {
      await client.request("fs/read_text_file", { sessionId, path: "/etc/hosts" });
      outside = "allowed";
    } catch {
      outside = "denied";
    }
    const inside = await client.request("fs/read_text_file", {
      sessionId,
      path: join(cwd, "a.txt"),
      line: 2,
      limit: 1,
    });
    await send({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: `outside=${outside} inside=${inside.content}` },
    });
    return { stopReason: "end_turn" };
  }

  await send({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: `echo:${text}${images ? ` images=${images}` : ""}` },
  });
  return { stopReason: "end_turn" };
});

app.connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
