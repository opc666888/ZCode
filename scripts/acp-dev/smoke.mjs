#!/usr/bin/env node
// ACP Bridge 无界面冒烟：直接以子进程拉起 Agent CLI 的 `app-server --stdio`，
// 用 NDJSON 讲 ZCode 协议（@zcode/protocol-v4），不经过桌面 Host / Electron。
//
// 阶段（对应 docs/acp-bridge/DESIGN.md §8 第 3 条）：
//   1 handshake   runtime/capabilities
//   2 draft       v4 createSession（无首条消息）→ 订阅 conversation/<id> 拿 snapshot
//   3 providers   订阅 workspace-config/<workspaceKey>，列出模型选择器里的 provider 分组，检查 acp:fake
//   4 acp-turn    createSession(firstInput, modelSelection=acp:fake/default) → 轮询快照到回合结束，
//                 自动处理权限弹窗（默认 allowOnce），打印 rows/plan/subagents/availability 摘要并断言
//   5 child       订阅子智能体的 conversation/<childSessionId>，确认可订阅
//   4b permission 同会话发 edit 剧本，处理权限弹窗（默认 allowOnce，--deny 拒绝），看 Edit 工具行结果
//   6 stop        再发一轮慢回合（hang 剧本），发送 stop，确认回合被中止
//
// 用法：
//   node scripts/acp-dev/smoke.mjs                 # 跑到能跑的最远阶段；W1/W2 未就绪的阶段记 PENDING
//   node scripts/acp-dev/smoke.mjs --strict        # 任何 PENDING 都算失败（集成后主控验收用）
//   node scripts/acp-dev/smoke.mjs --deny          # 权限请求一律拒绝（验证拒绝路径）
//   node scripts/acp-dev/smoke.mjs --timeout 90    # 单阶段超时秒数（默认 60）
//   node scripts/acp-dev/smoke.mjs --verbose       # 打印 CLI stderr 与所有入站消息方法名
// 环境变量：
//   ACP_DEV_ROOT          隔离根（默认 <项目工作区>/workspace-runtime/tmp/20261119-zcode-acp）
//   ACP_SMOKE_PROMPT      第 4 阶段发送的文本（默认见 DEFAULT_PROMPT，fake agent 按脚本响应）
//   ACP_SMOKE_EDIT_PROMPT 第 4b 阶段发送的文本（默认 edit 剧本）
//   ACP_SMOKE_SLOW_PROMPT 第 6 阶段发送的文本（默认 hang 剧本：流一段文本后等 session/cancel）
//   ACP_SMOKE_AGENT_CMD / ACP_SMOKE_AGENT_ARGS_JSON  覆盖 acp-agents.json 里 fake 的 command/args
//
// 硬性约束：只写隔离根；子进程 HOME / ZCODE_DATA_BASE_DIR / TMPDIR 全部指到隔离根；不登录、不调用真实模型。

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

// ── 参数与路径 ──
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const STRICT = flag("--strict");
const DENY = flag("--deny");
const VERBOSE = flag("--verbose");
const STAGE_TIMEOUT_MS = Number(opt("--timeout", "60")) * 1000;
const DUMP = flag("--dump"); // 把关键快照完整写到 <隔离根>/logs/smoke-dump-*/ 便于排查

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const devRoot = resolve(
  process.env.ACP_DEV_ROOT?.trim() ||
    join(repoRoot, "..", "workspace-runtime", "tmp", "20261119-zcode-acp"),
);
const home = process.env.HOME ?? "";
if (devRoot === home || devRoot.startsWith("/tmp") || devRoot.startsWith("/private/tmp")) {
  console.error(`[smoke] 拒绝：隔离根不能是 HOME 或 /tmp：${devRoot}`);
  process.exit(2);
}
const dataDir = join(devRoot, "data");
const homeDir = join(devRoot, "home");
const tmpDir = join(devRoot, "tmpdir");
const logDir = join(devRoot, "logs");
const workspaceDir = join(devRoot, "smoke-workspace");
for (const dir of [dataDir, homeDir, tmpDir, logDir, workspaceDir, join(dataDir, ".zcode")]) {
  mkdirSync(dir, { recursive: true });
}
// macOS 的 Unix socket 路径上限 104 字节，隔离目录（含中文）太长，CLI 在 TMPDIR 下建
// znr-<uuid>.sock 会 EINVAL。用一个短软链指向隔离 tmpdir：文件实际仍落在隔离根，只有软链在 HOME。
function ensureShortTmpLink(target) {
  const link = process.env.ACP_DEV_SHORT_TMP?.trim() || join(home, ".zacp-tmp");
  try {
    const st = lstatSync(link);
    if (!st.isSymbolicLink() || resolve(dirname(link), readlinkSync(link)) !== target) {
      throw new Error(`${link} 已存在且不是指向 ${target} 的软链，请手动处理或设 ACP_DEV_SHORT_TMP`);
    }
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    symlinkSync(target, link);
  }
  return link;
}
const shortTmp = ensureShortTmpLink(tmpDir);
const cliEntry = join(repoRoot, "apps/zcode-cli/packages/cli/dist/zcode.cjs");
const fakeAgent = join(repoRoot, "apps/zcode-cli/packages/acp-engine/test/fake-agent.mjs");
const ACP_PROVIDER_ID = "acp:fake";
// fake-agent.mjs 按 prompt 第一个词选剧本：full（文本/思考/工具+diff/plan/子智能体/usage）、
// edit（Edit 工具 + 权限请求）、hang（流一段文本后等 session/cancel）。
const DEFAULT_PROMPT = process.env.ACP_SMOKE_PROMPT?.trim() || "full smoke run";
const EDIT_PROMPT = process.env.ACP_SMOKE_EDIT_PROMPT?.trim() || "edit smoke run";
const SLOW_PROMPT = process.env.ACP_SMOKE_SLOW_PROMPT?.trim() || "hang smoke run";

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const stderrLogPath = join(logDir, `smoke-cli-stderr-${stamp}.log`);
const stderrLog = createWriteStream(stderrLogPath);
const dumpDir = join(logDir, `smoke-dump-${stamp}`);
function dump(name, value) {
  if (!DUMP) return;
  mkdirSync(dumpDir, { recursive: true });
  writeFileSync(join(dumpDir, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
}

// ── 结果记账 ──
const results = []; // { stage, status: PASS|FAIL|PENDING|SKIP, detail }
function record(stage, status, detail = "") {
  results.push({ stage, status, detail });
  const tag = { PASS: "✔", FAIL: "✘", PENDING: "…", SKIP: "-" }[status] ?? "?";
  console.log(`[smoke] ${tag} ${stage}: ${status}${detail ? ` — ${detail}` : ""}`);
}
function log(...args) {
  console.log("[smoke]", ...args);
}

// CLI 自己的结构化日志（按 HOME 解析 → <隔离根>/home/.zcode/cli/log/*.jsonl）。
// 回合失败时快照里往往只看到 phase，真正原因（如 turn.failed / model_creation）在这里。
const smokeStartedAt = new Date().toISOString();
function cliLogProblems(limit = 8) {
  const dir = join(homeDir, ".zcode", "cli", "log");
  let files = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => join(dir, f));
  } catch {
    return [];
  }
  const out = [];
  for (const file of files) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.includes('"level":"error"') && !line.includes("acp_bridge")) continue;
      let j;
      try {
        j = JSON.parse(line);
      } catch {
        continue;
      }
      if (!j.timestamp || j.timestamp < smokeStartedAt) continue;
      if (j.level !== "error" && !(j.level === "warn" && String(j.event).startsWith("acp_bridge"))) continue;
      const cause = j.error?.cause?.message ?? j.errorMessage ?? j.error?.message ?? "";
      out.push(`${j.timestamp.slice(11, 23)} ${j.event} ${j.context?.turnPhase ?? ""} ${j.message ?? ""}${cause ? ` ← ${cause}` : ""}`);
    }
  }
  return out.slice(-limit);
}
function printCliLogProblems() {
  const problems = cliLogProblems();
  if (problems.length) {
    log("CLI 日志里的错误（最近几条）：");
    for (const p of problems) log(`  ${p}`);
  }
}

// ── acp-agents.json（只写隔离目录）──
function writeAcpAgentsConfig() {
  const configPath = join(dataDir, ".zcode", "acp-agents.json");
  const command = process.env.ACP_SMOKE_AGENT_CMD?.trim() || process.execPath;
  const args = process.env.ACP_SMOKE_AGENT_ARGS_JSON
    ? JSON.parse(process.env.ACP_SMOKE_AGENT_ARGS_JSON)
    : [fakeAgent];
  const config = {
    agents: [
      { id: "fake", name: "Fake ACP Agent (smoke)", command, args, models: ["default", "slow"] },
    ],
  };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return { configPath, fakeAgentReady: existsSync(args[0] ?? "") || Boolean(process.env.ACP_SMOKE_AGENT_CMD) };
}

// ── NDJSON 客户端 ──
class ProtocolClient {
  constructor(child) {
    this.child = child;
    this.nextId = 1;
    this.pending = new Map();
    this.postResponseFrames = new Map(); // subscriptionId -> 完整逻辑帧数组
    this.fragments = new Map(); // logicalFrameId -> { count, parts[] }
    this.frameWaiters = [];
    this.deltaOpCounts = new Map();
    this.incomingMethods = new Map();
    this.closed = false;
    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => this.onLine(line));
    child.on("exit", (code, signal) => {
      this.closed = true;
      const err = new Error(`CLI 退出 code=${code} signal=${signal}`);
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
    });
  }

  onLine(line) {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      if (VERBOSE) log("非 JSON 输出行：", line.slice(0, 200));
      return;
    }
    if ("id" in msg && ("result" in msg || "error" in msg) && !("method" in msg)) {
      const waiter = this.pending.get(msg.id);
      if (waiter) {
        this.pending.delete(msg.id);
        if ("error" in msg) waiter.reject(Object.assign(new Error(msg.error.message), { protocolError: msg.error }));
        else waiter.resolve(msg.result);
      }
      return;
    }
    if (typeof msg.method === "string") {
      this.incomingMethods.set(msg.method, (this.incomingMethods.get(msg.method) ?? 0) + 1);
      if (VERBOSE) log("<-", msg.method, "id" in msg ? `(request ${msg.id})` : "");
      if ("id" in msg) {
        this.answerReverseRequest(msg);
        return;
      }
      if (msg.method === "v4/conversation/frame") this.onWire(msg.params);
    }
  }

  // CLI → Host 的反向请求：冒烟没有真 Host，一律回 method-not-found（不提供凭据、不提供浏览器）。
  answerReverseRequest(msg) {
    // interaction/*（权限、提问）：真实桌面 Host 会挂起这个反向请求，等用户在界面作答；
    // CLI 侧与 v4 resolveInteraction 竞速，v4 应答先到就自行取消这条 RPC。
    // 这里同样挂起不回——立即回错会被当成「Host 拒绝」，ACP 智能体收到的就是 cancelled。
    if (msg.method.startsWith("interaction/")) return;
    this.write({
      id: msg.id,
      error: { code: -32601, message: `smoke host does not implement ${msg.method}` },
    });
  }

  onWire(wire) {
    if (!wire || typeof wire !== "object") return;
    let frame;
    if (wire.kind === "complete") {
      frame = wire.frame;
    } else if (wire.kind === "fragment") {
      const entry = this.fragments.get(wire.logicalFrameId) ?? { count: wire.fragmentCount, parts: [] };
      entry.parts[wire.fragmentIndex] = Buffer.from(wire.dataBase64, "base64");
      this.fragments.set(wire.logicalFrameId, entry);
      if (entry.parts.filter(Boolean).length < entry.count) return;
      this.fragments.delete(wire.logicalFrameId);
      frame = JSON.parse(Buffer.concat(entry.parts).toString("utf8"));
    } else {
      return;
    }
    if (frame?.payload?.kind === "deltas") {
      for (const d of frame.payload.deltas ?? []) {
        const op = d?.op ?? d?.kind ?? "?";
        this.deltaOpCounts.set(op, (this.deltaOpCounts.get(op) ?? 0) + 1);
      }
    }
    const subId = wire.subscriptionId;
    const list = this.postResponseFrames.get(subId) ?? [];
    list.push(frame);
    this.postResponseFrames.set(subId, list);
    this.frameWaiters = this.frameWaiters.filter((w) => !w(subId, frame));
  }

  write(obj) {
    if (this.closed) throw new Error("CLI 已退出");
    this.child.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  request(method, params, timeoutMs = STAGE_TIMEOUT_MS) {
    const id = this.nextId++;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 超时 ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolvePromise(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      this.write({ id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  // 订阅 snapshot 帧会在 response 之后作为 notification 发出；按 subscriptionId 等第一帧。
  waitFirstFrame(subscriptionId, timeoutMs = STAGE_TIMEOUT_MS) {
    const existing = this.postResponseFrames.get(subscriptionId);
    if (existing?.length) return Promise.resolve(existing[0]);
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error(`等待 ${subscriptionId} 首帧超时`)), timeoutMs);
      this.frameWaiters.push((subId, frame) => {
        if (subId !== subscriptionId) return false;
        clearTimeout(timer);
        resolvePromise(frame);
        return true;
      });
    });
  }
}

// ── 协议辅助 ──
const workspaceRef = { workspacePath: workspaceDir, workspaceKey: workspaceDir };
const clientId = `acp-smoke-${randomUUID()}`;

function command(client, sessionId, type, payload, extra = {}) {
  return client.request("v4/command", {
    workspace: workspaceRef,
    commandId: randomUUID(),
    clientId,
    sessionId,
    type,
    payload,
    issuedAt: Date.now(),
    ...extra,
  });
}

// 每次用新 connectionId 订阅拿一份完整 snapshot，然后退订（冒烟不维护 delta 应用逻辑）。
async function freshSnapshot(client, topic) {
  const connectionId = `smoke-conn-${randomUUID()}`;
  const res = await client.request("v4/conversation/subscribe", {
    topic,
    connectionId,
    clientMode: "desktop-continuous",
    workspace: workspaceRef,
  });
  const ack = res?.ack ?? res;
  const frame = await client.waitFirstFrame(ack.subscriptionId);
  await client
    .request("v4/conversation/unsubscribe", { topic, subscriptionId: ack.subscriptionId, connectionId })
    .catch(() => {});
  client.postResponseFrames.delete(ack.subscriptionId);
  return { ack, frame };
}

async function conversationSnapshot(client, sessionId) {
  const { frame } = await freshSnapshot(client, `conversation/${sessionId}`);
  if (frame?.payload?.kind !== "snapshot") throw new Error(`conversation/${sessionId} 首帧不是 snapshot`);
  return frame.payload.snapshot;
}

function summarizeSnapshot(s) {
  const rows = s.rows?.window ?? [];
  const kinds = {};
  for (const r of rows) kinds[r.kind] = (kinds[r.kind] ?? 0) + 1;
  const toolRows = rows.filter((r) => r.kind === "toolCall");
  const subagentRows = rows.filter((r) => r.kind === "subagent");
  const availability = Object.fromEntries(
    Object.entries(s.availability ?? {}).map(([k, v]) => [k, v?.allowed ? "allowed" : `denied(${v?.reasonCode ?? "?"})`]),
  );
  return {
    phase: s.control?.phase,
    lastError: s.control?.lastError ?? null,
    model: s.config?.modelSelection ?? s.config?.model ?? null,
    rowKinds: kinds,
    rowsTotal: s.rows?.totalCount,
    tools: toolRows.map((r) => ({ name: r.toolName, status: r.status, display: r.display?.kind ?? r.output?.display?.kind ?? null })),
    plan: s.plan?.items?.map((i) => `${i.status}:${i.content}`) ?? null,
    subagents: {
      rows: subagentRows.map((r) => ({ type: r.subagentType, status: r.status, child: r.childSessionId ?? null })),
      running: s.subagents?.running?.length ?? 0,
      childSessionIds: s.subagents?.childSessionIds ?? [],
      endedTotal: s.subagents?.endedTotal ?? 0,
    },
    availability,
    pendingInteractions: (s.pendingInteractions ?? []).map((p) => `${p.kind}:${p.payload?.toolName ?? ""}`),
    usage: s.usage ?? null,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ENDED = new Set(["completedSuccess", "completedInterrupted", "error"]);

// 轮询到回合结束；遇到权限请求按 --deny 决定 allowOnce / deny。
// sinceTotal：发送前的 rows.totalCount；同一会话的后续回合必须看到行数增长才算新回合（避免读到上一轮的完成态）。
async function waitTurnEnd(client, sessionId, { onPoll, sinceTotal = -1, permissionLog } = {}) {
  const deadline = Date.now() + STAGE_TIMEOUT_MS;
  const answered = new Set();
  let snap;
  while (Date.now() < deadline) {
    snap = await conversationSnapshot(client, sessionId);
    await onPoll?.(snap);
    for (const p of snap.pendingInteractions ?? []) {
      if (answered.has(p.interactionId)) continue;
      if (p.kind !== "permission") continue;
      const want = DENY ? "deny" : "allowOnce";
      const option = p.payload.options.find((o) => o.kind === want) ?? p.payload.options[0];
      log(`权限请求 ${p.payload.toolName}「${p.payload.summary}」→ ${option?.kind}(${option?.optionId})`);
      answered.add(p.interactionId);
      permissionLog?.push({ toolName: p.payload.toolName, optionKind: option?.kind });
      const ack = await command(client, sessionId, "resolveInteraction", {
        interactionId: p.interactionId,
        answer: { optionId: option.optionId },
      });
      log(`  resolveInteraction ack=${ack?.status}${ack?.reasonCode ? ` ${ack.reasonCode}` : ""}`);
    }
    if (
      ENDED.has(snap.control?.phase) &&
      !(snap.pendingInteractions ?? []).length &&
      (snap.rows?.totalCount ?? 0) > sinceTotal
    )
      return snap;
    await sleep(400);
  }
  throw Object.assign(new Error(`回合在 ${STAGE_TIMEOUT_MS}ms 内未结束`), { snapshot: snap });
}

// ── 主流程 ──
async function main() {
  log(`仓库：${repoRoot}`);
  log(`隔离根：${devRoot}`);
  log(`  ZCODE_DATA_BASE_DIR=${dataDir}`);
  log(`  HOME=${homeDir}`);
  log(`  TMPDIR=${shortTmp} -> ${tmpDir}`);
  log(`  workspace=${workspaceDir}`);
  log(`  CLI stderr 日志：${stderrLogPath}`);
  if (!existsSync(cliEntry)) {
    record("build", "FAIL", `缺少 ${cliEntry}，先跑 bash scripts/acp-dev/build-cli.sh`);
    return;
  }
  const { configPath, fakeAgentReady } = writeAcpAgentsConfig();
  log(`acp-agents.json：${configPath}（fake agent ${fakeAgentReady ? "就绪" : "未就绪，等待 W1"}）`);

  // 子进程环境：去掉所有继承的 ZCODE_* / ELECTRON_*，再显式指到隔离目录。
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("ZCODE_") && !k.startsWith("ELECTRON_")),
  );
  Object.assign(env, {
    HOME: homeDir,
    USERPROFILE: homeDir,
    TMPDIR: shortTmp,
    ZCODE_DATA_BASE_DIR: dataDir,
    ZCODE_ENV: process.env.ZCODE_ENV?.trim() || "production",
  });

  const child = spawn(process.execPath, [cliEntry, "app-server", "--stdio"], {
    cwd: workspaceDir,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.on("data", (chunk) => {
    stderrLog.write(chunk);
    if (VERBOSE) process.stderr.write(chunk);
  });
  const client = new ProtocolClient(child);

  try {
    // 1 handshake
    try {
      const caps = await client.request("runtime/capabilities", {}, 90_000);
      record("1 handshake", "PASS", `runtime/capabilities=${JSON.stringify(caps)}`);
    } catch (e) {
      record("1 handshake", "FAIL", e.message);
      return;
    }

    // 2 draft session
    let draftId;
    let draftSnap;
    try {
      const ack = await command(client, null, "createSession", { workspaceId: workspaceRef.workspaceKey });
      draftId = ack?.result?.sessionId;
      if (ack?.status !== "accepted" || !draftId) throw new Error(`ack=${JSON.stringify(ack)}`);
      const snap = await conversationSnapshot(client, draftId);
      dump("draft-snapshot", snap);
      draftSnap = snap;
      const sum = summarizeSnapshot(snap);
      record("2 draft", "PASS", `sessionId=${draftId} phase=${sum.phase} model=${JSON.stringify(sum.model)}`);
    } catch (e) {
      record("2 draft", "FAIL", e.message);
    }

    // 3 providers（workspace-config 目录只有在该 workspace 有活会话时才有内容，所以放在 draft 之后）
    let hasAcpProvider = false;
    try {
      const { frame } = await freshSnapshot(client, `workspace-config/${workspaceRef.workspaceKey}`);
      const options = frame?.payload?.snapshot?.config?.configOptions ?? [];
      const modelOpt = options.find((o) => o.id === "model");
      log(
        `workspace-config：payload=${frame?.payload?.kind} 选项=[${options.map((o) => `${o.id}(${o.options?.length ?? 0})`).join(", ")}] slash 命令=${frame?.payload?.snapshot?.config?.slashCommands?.length ?? 0}`,
      );
      const groups = new Map();
      for (const v of modelOpt?.options ?? []) {
        const key = v.modelProviderId ?? "(无分组)";
        groups.set(key, [...(groups.get(key) ?? []), v.value]);
      }
      log("模型选择器 provider 分组：");
      if (groups.size === 0) log("  （空：未登录时内置 provider 不可用，属预期）");
      for (const [k, v] of groups) log(`  ${k}: ${v.join(", ")}`);
      const inPicker = [...groups.keys()].some((k) => k === ACP_PROVIDER_ID) ||
        (modelOpt?.options ?? []).some((v) => String(v.value).includes(ACP_PROVIDER_ID));
      // CLI 的 workspace-config 不下发模型清单（桌面模型选择器读的是 Host 自己的 ProviderRuntime），
      // 无界面时只能看 CLI Registry 是否认得 acp:fake：未登录时内置 provider 全不可用，
      // 新草稿会话的默认选择若落到 acp:fake，说明它已进 CLI Registry 且通过准入校验。
      const draftProvider = draftSnap?.config?.modelSelection?.providerId ?? draftSnap?.config?.provider;
      const inCliRegistry = draftProvider === ACP_PROVIDER_ID;
      hasAcpProvider = inPicker || inCliRegistry;
      record(
        "3 providers",
        hasAcpProvider ? "PASS" : "PENDING",
        inPicker
          ? `${ACP_PROVIDER_ID} 在 workspace-config 模型选项中`
          : inCliRegistry
            ? `${ACP_PROVIDER_ID} 在 CLI Registry 中（草稿默认选择=${ACP_PROVIDER_ID}；GUI 模型选择器由 Host 提供，另见 GUI 验证）`
            : `${ACP_PROVIDER_ID} 未出现（等 W2 Provider 注册）`,
      );
    } catch (e) {
      record("3 providers", "FAIL", e.message);
    }

    // 4 ACP turn
    if (!fakeAgentReady || !hasAcpProvider) {
      record("4 acp-turn", "PENDING", !fakeAgentReady ? "fake-agent.mjs 未就绪（W1）" : "acp provider 未注册（W2）");
      record("5 child-subscribe", "PENDING", "依赖第 4 阶段");
      record("4b permission", "PENDING", "依赖第 4 阶段");
      record("6 stop", "PENDING", "依赖第 4 阶段");
      return;
    }
    let acpSessionId;
    let finalSnap;
    try {
      const ack = await command(client, null, "createSession", {
        workspaceId: workspaceRef.workspaceKey,
        firstInput: { text: DEFAULT_PROMPT, modelSelection: { providerId: ACP_PROVIDER_ID, modelId: "default" } },
      });
      acpSessionId = ack?.result?.sessionId;
      if (ack?.status !== "accepted" || !acpSessionId) throw new Error(`createSession ack=${JSON.stringify(ack)}`);
      finalSnap = await waitTurnEnd(client, acpSessionId);
      const sum = summarizeSnapshot(finalSnap);
      log("快照摘要：", JSON.stringify(sum, null, 2));
      log("实时 delta 计数：", JSON.stringify(Object.fromEntries(client.deltaOpCounts)));

      // DESIGN §8 第 3 条断言
      const problems = [];
      if (!sum.rowKinds.assistantText) problems.push("缺文本行 assistantText");
      if (!sum.tools.length) problems.push("缺工具行 toolCall");
      if (!sum.tools.some((t) => t.display === "file_diff")) problems.push("工具行无 file_diff（row.display 或 row.output.display）");
      if (!sum.plan?.length) problems.push("plan 为空");
      const subRow = sum.subagents.rows.find((r) => r.child);
      if (!subRow) problems.push("缺带 childSessionId 的子智能体行");
      for (const key of ["fork", "compact", "rewindFiles", "pauseGoal", "resumeGoal"]) {
        const v = finalSnap.availability?.[key];
        if (v && v.allowed !== false) problems.push(`availability.${key} 应为 allowed:false`);
      }
      if (finalSnap.availability?.switchModelConfig?.allowed === false)
        problems.push("availability.switchModelConfig 应允许");
      if (DENY) {
        // 拒绝路径：只要求回合正常结束且有工具行；diff/子智能体可能因拒绝而缺失。
        record("4 acp-turn(deny)", finalSnap.control.phase === "error" ? "FAIL" : "PASS", `phase=${finalSnap.control.phase}`);
      } else {
        record("4 acp-turn", problems.length ? "FAIL" : "PASS", problems.join("；") || `phase=${sum.phase}`);
      }
      if (problems.length) printCliLogProblems();
      dump("acp-turn-snapshot", finalSnap);

      // 5 子会话可订阅
      if (subRow) {
        try {
          const childSnap = await conversationSnapshot(client, subRow.child);
          const cs = summarizeSnapshot(childSnap);
          const ok = Object.keys(cs.rowKinds).length > 0;
          record("5 child-subscribe", ok ? "PASS" : "FAIL", `child=${subRow.child} rows=${JSON.stringify(cs.rowKinds)}`);
        } catch (e) {
          record("5 child-subscribe", "FAIL", e.message);
        }
      } else {
        record("5 child-subscribe", "FAIL", "没有 childSessionId 可订阅");
      }
    } catch (e) {
      record("4 acp-turn", "FAIL", e.message);
      printCliLogProblems();
      if (e.snapshot) log("最后一次快照：", JSON.stringify(summarizeSnapshot(e.snapshot), null, 2));
      record("5 child-subscribe", "SKIP", "第 4 阶段失败");
    }

    // 4b 权限：同会话发 edit 剧本，fake agent 发 session/request_permission；默认 allowOnce，--deny 时拒绝
    if (acpSessionId) {
      try {
        const before = await conversationSnapshot(client, acpSessionId);
        const permissionLog = [];
        const ack = await command(client, acpSessionId, "sendText", {
          text: EDIT_PROMPT,
          modelSelection: { providerId: ACP_PROVIDER_ID, modelId: "default" },
        });
        if (ack?.status !== "accepted") throw new Error(`sendText ack=${JSON.stringify(ack)}`);
        const snap = await waitTurnEnd(client, acpSessionId, {
          sinceTotal: before.rows?.totalCount ?? 0,
          permissionLog,
        });
        // 按「最后一轮」取行：rowId 是字符串，按大小比较不可靠。
        const rowsNow = snap.rows?.window ?? [];
        const lastTurnId = rowsNow.filter((r) => r.kind === "turnHeader").at(-1)?.turnId;
        const newRows = rowsNow.filter((r) => r.turnId === lastTurnId);
        const editRow = newRows.find((r) => r.kind === "toolCall");
        const expectStatus = DENY ? ["error", "cancelled"] : ["success"];
        const ok = permissionLog.length > 0 && editRow && expectStatus.includes(editRow.status);
        record(
          "4b permission",
          ok ? "PASS" : "FAIL",
          `弹窗=${JSON.stringify(permissionLog)} 工具=${editRow ? `${editRow.toolName}:${editRow.status}:${editRow.display?.kind ?? "-"}` : "无"}`,
        );
      } catch (e) {
        record("4b permission", "FAIL", e.message);
      }
    }

    // 6 stop：在同一会话再发一条慢回合（fake agent 的 hang 剧本），running 后 stop
    if (!acpSessionId) {
      record("6 stop", "SKIP", "无 ACP 会话");
      return;
    }
    try {
      const beforeStop = await conversationSnapshot(client, acpSessionId);
      const sendAck = await command(client, acpSessionId, "sendText", {
        text: SLOW_PROMPT,
        modelSelection: { providerId: ACP_PROVIDER_ID, modelId: "default" },
      });
      if (sendAck?.status !== "accepted") throw new Error(`sendText ack=${JSON.stringify(sendAck)}`);
      const deadline = Date.now() + STAGE_TIMEOUT_MS;
      let snap;
      while (Date.now() < deadline) {
        snap = await conversationSnapshot(client, acpSessionId);
        if (snap.control?.phase === "running" && snap.control?.canStop) break;
        if (ENDED.has(snap.control?.phase) && (snap.rows?.totalCount ?? 0) > (beforeStop.rows?.totalCount ?? 0)) break;
        await sleep(200);
      }
      if (snap?.control?.phase !== "running") {
        record("6 stop", "FAIL", `回合未进入可停止的 running 态（phase=${snap?.control?.phase}）`);
        return;
      }
      const stopAck = await command(client, acpSessionId, "stop", {});
      log(`stop ack=${stopAck?.status}`);
      const ended = await waitTurnEnd(client, acpSessionId, { sinceTotal: beforeStop.rows?.totalCount ?? 0 });
      const phase = ended.control?.phase;
      record("6 stop", phase === "completedInterrupted" ? "PASS" : "FAIL", `phase=${phase}`);
    } catch (e) {
      record("6 stop", "FAIL", e.message);
    }
  } finally {
    if (VERBOSE) log("入站方法计数：", JSON.stringify(Object.fromEntries(client.incomingMethods)));
    child.stdin.end();
    const killTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise((r) => child.once("exit", r).once("error", r));
    }
    clearTimeout(killTimer);
    stderrLog.end();
  }
}

await main().catch((e) => record("fatal", "FAIL", e.stack ?? String(e)));
const failed = results.filter((r) => r.status === "FAIL" || (STRICT && r.status === "PENDING"));
console.log("\n[smoke] ── 结果 ──");
for (const r of results) console.log(`  ${r.status.padEnd(7)} ${r.stage}${r.detail ? `  ${r.detail.slice(0, 300)}` : ""}`);
console.log(`[smoke] CLI stderr：${stderrLogPath}`);
process.exit(failed.length ? 1 : 0);
