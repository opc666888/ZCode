#!/usr/bin/env node
// Claude 360 Code（ZCODE_C360_IDENTITY=1）随包的 Claude Code ACP 适配器（owner 2026-11-21）。
// 只装适配器本身（纯 JS，跨平台同一份），不装 claude-agent-sdk 的平台程序（单平台 200MB+）：
// 运行时用 CLAUDE_CODE_EXECUTABLE 指向用户电脑上已装的 Claude Code（acp-engine/config.ts）。
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const ACP_CLAUDE_VERSION = "0.100.0";
// 放在 bundled-acp-claude/pkg/ 下：electron-builder 会过滤 extraResources 根目录的 node_modules，下一层不受影响
const root = resolve(import.meta.dirname, "..", "bundled-acp-claude");
const out = join(root, "pkg");
const entry = join(out, "node_modules", "@agentclientprotocol", "claude-agent-acp", "dist", "index.js");
const stamp = join(out, ".version");

if (process.env.ZCODE_C360_IDENTITY?.trim() !== "1") {
  console.log("[prepare:acp-claude] 不是 Claude 360 Code 构建，跳过");
  process.exit(0);
}
if (existsSync(entry) && existsSync(stamp)) {
  console.log(`[prepare:acp-claude] 已有 ${ACP_CLAUDE_VERSION}，跳过`);
  process.exit(0);
}
rmSync(root, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "package.json"), JSON.stringify({ name: "c360-acp-claude", private: true, dependencies: { "@agentclientprotocol/claude-agent-acp": ACP_CLAUDE_VERSION } }, null, 2));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
execFileSync(npm, ["install", "--omit=optional", "--ignore-scripts", "--no-audit", "--no-fund", "--registry", "https://registry.npmjs.org/"], { cwd: out, stdio: "inherit", shell: process.platform === "win32" });
if (!existsSync(entry)) throw new Error("claude-agent-acp 安装后找不到入口");
writeFileSync(stamp, ACP_CLAUDE_VERSION);
console.log(`[prepare:acp-claude] staged claude-agent-acp@${ACP_CLAUDE_VERSION} into ${out}`);
