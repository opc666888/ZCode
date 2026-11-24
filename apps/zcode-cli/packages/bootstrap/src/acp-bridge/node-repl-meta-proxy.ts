/**
 * acp-bridge：node_repl 会话身份中继。
 *
 * Claude Code 的 MCP client 调 node_repl 时不写 ZCode 的 `com.zcode/request-context`，电脑操作 /
 * 浏览器操作会报「missing session_id metadata」。node_repl 宿主是官方插件缓存里的版本（不随本包更新），
 * 所以不改宿主，而是在 Claude 和宿主之间夹一层 stdio 中继：逐行转发 JSON-RPC，遇到 tools/call 且
 * 没带会话身份的，补上宿主给的身份（来自启动环境变量，只有宿主能设，模型改不了）。
 * 中继逻辑只以纯 JS 字符串存在（避免打包改名），测试直接跑这份脚本。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const NODE_REPL_PROXY_TARGET_ENV = "ZCODE_NODE_REPL_PROXY_TARGET";
export const NODE_REPL_PROXY_CONTEXT_ENV = "ZCODE_NODE_REPL_PROXY_CONTEXT";
export const REQUEST_CONTEXT_META_KEY = "com.zcode/request-context";

/** 中继脚本正文（CommonJS，跑在宿主同一个 Node / ELECTRON_RUN_AS_NODE 下）。 */
export const NODE_REPL_PROXY_SCRIPT = `"use strict";
const { spawn } = require("node:child_process");
const TARGET_ENV = ${JSON.stringify(NODE_REPL_PROXY_TARGET_ENV)};
const CONTEXT_ENV = ${JSON.stringify(NODE_REPL_PROXY_CONTEXT_ENV)};
const KEY = ${JSON.stringify(REQUEST_CONTEXT_META_KEY)};
const target = JSON.parse(process.env[TARGET_ENV] || "{}");
let context = {};
try { context = JSON.parse(process.env[CONTEXT_ENV] || "{}"); } catch {}
const env = { ...process.env };
delete env[TARGET_ENV];
delete env[CONTEXT_ENV];
const child = spawn(target.command, target.args || [], { env, stdio: ["pipe", "pipe", "inherit"] });
function inject(message) {
  if (Array.isArray(message)) return message.map(inject);
  if (!message || typeof message !== "object" || message.method !== "tools/call") return message;
  const params = message.params && typeof message.params === "object" ? message.params : {};
  const meta = params._meta && typeof params._meta === "object" ? params._meta : {};
  const existing = meta[KEY] && typeof meta[KEY] === "object" ? meta[KEY] : {};
  if (typeof existing.session_id === "string" && existing.session_id.trim()) return message;
  return { ...message, params: { ...params, _meta: { ...meta, [KEY]: { ...existing, ...context } } } };
}
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    let out = line;
    if (line.trim() && context.session_id) {
      try { out = JSON.stringify(inject(JSON.parse(line))); } catch {}
    }
    child.stdin.write(out + "\\n");
  }
});
process.stdin.on("end", () => { if (buf) child.stdin.write(buf); child.stdin.end(); });
child.stdout.pipe(process.stdout);
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
child.on("error", (error) => { process.stderr.write("[node-repl-proxy] " + error.message + "\\n"); process.exit(1); });
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => { try { child.kill(sig); } catch {} });
`;

/** 把中继脚本写到状态目录（内容变了才重写），返回路径。 */
export function ensureNodeReplProxyScript(stateDir: string): string {
  mkdirSync(stateDir, { recursive: true });
  const path = join(stateDir, "node-repl-meta-proxy.cjs");
  let current: string | undefined;
  try {
    current = readFileSync(path, "utf8");
  } catch {
    /* 首次 */
  }
  if (current !== NODE_REPL_PROXY_SCRIPT) writeFileSync(path, NODE_REPL_PROXY_SCRIPT);
  return path;
}
