/**
 * acp-bridge：把宿主已解析好的插件能力交给外部 ACP 智能体（Claude Code）。
 *
 * 2026-11-24 实测问题：Claude 会话里 session/new 的 mcpServers 恒为空，插件市场装的插件
 * （Word/Excel/PPT/PDF、电脑操作、浏览器操作……）和它们的技能 Claude 一个都拿不到。
 *
 * 做法：
 * - MCP：直接用 create-app 已解析的 runtimeConfig.mcp.servers（含插件 MCP、内置 node_repl 宿主，
 *   以及 CUA / 浏览器 broker 已注入的环境变量），转成 ACP 的 mcpServers。
 * - 技能：为每个启用插件在 `<stateDir>/claude-plugins/<name>/` 生成一个 Claude Code 插件外壳
 *   （`.claude-plugin/plugin.json` + 指向原 skills 目录的软链），经 `--plugin-dir-no-mcp` 传入，
 *   MCP 不重复启动。
 * 跳过：已禁用的、未受信任的项目 MCP、需要智谱官方登录凭据（auth: zcode_official）或 OAuth 的。
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { AcpMcpServer, AcpSessionResources } from "@zcode/acp-engine";
import type { McpServerConfig, PluginMetadata, SkillRoot } from "@zcode/contracts";

/** 只对 ZCode 自身有意义、对 Claude 会话没用的插件。 */
const SKIP_PLUGIN_NAMES = new Set(["zcode-guide", "restore-legacy-sessions", "zcode-site"]);
const SKIP_MCP_PREFIXES = [...SKIP_PLUGIN_NAMES].map((name) => `plugin:${name}:`);

export interface HostSessionResourcesInput {
  mcpServers: Record<string, McpServerConfig>;
  untrustedServerNames?: ReadonlySet<string>;
  plugins: readonly PluginMetadata[];
  skillRoots: readonly SkillRoot[];
  /** 生成 Claude 插件外壳的目录（acp-bridge 状态目录）。 */
  stateDir: string;
}

/** 已解析的宿主资源；每轮按会话 cwd 展开占位符。 */
export interface HostSessionResources {
  forCwd(cwd: string): AcpSessionResources;
}

export function toAcpServerName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "mcp";
}

function expand(value: string, cwd: string): string {
  return value
    .replaceAll("${ZCODE_PROJECT_DIR}", cwd)
    .replaceAll("${ZCODE_WORKSPACE_ROOT}", cwd)
    .replaceAll("${CLAUDE_PROJECT_DIR}", cwd);
}

export function convertMcpServers(
  servers: Record<string, McpServerConfig>,
  cwd: string,
  untrusted: ReadonlySet<string> = new Set(),
): AcpMcpServer[] {
  const out: AcpMcpServer[] = [];
  const used = new Set<string>();
  for (const [rawName, config] of Object.entries(servers)) {
    if (config.enabled === false || untrusted.has(rawName)) continue;
    if (SKIP_MCP_PREFIXES.some((prefix) => rawName.startsWith(prefix))) continue;
    if ("auth" in config && config.auth) continue; // 需要智谱官方登录凭据，Claude 会话里拿不到
    let name = toAcpServerName(rawName);
    while (used.has(name)) name = `${name}_`;
    used.add(name);
    if (config.type === "stdio") {
      const env = { ...config.env };
      if (config.cwd && !env.ZCODE_WORKSPACE_ROOT) env.ZCODE_WORKSPACE_ROOT = expand(config.cwd, cwd);
      out.push({
        name,
        command: expand(config.command, cwd),
        args: (config.args ?? []).map((arg) => expand(arg, cwd)),
        env: Object.entries(env).map(([key, value]) => ({ name: key, value: expand(String(value), cwd) })),
      });
    } else if (!config.oauth) {
      out.push({
        type: config.type,
        name,
        url: config.url,
        headers: Object.entries(config.headers ?? {}).map(([key, value]) => ({ name: key, value })),
      });
    }
  }
  return out;
}

function ensureSymlink(link: string, target: string): void {
  if (existsSync(link) || isBrokenLink(link)) {
    try {
      if (lstatSync(link).isSymbolicLink() && readlinkSync(link) === target) return;
    } catch {
      /* 重建 */
    }
    rmSync(link, { recursive: true, force: true });
  }
  symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
}

function isBrokenLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** 为启用插件生成 Claude Code 插件外壳，返回目录列表。失败的插件跳过，不影响会话。 */
export function materializeClaudePluginShells(
  plugins: readonly PluginMetadata[],
  skillRoots: readonly SkillRoot[],
  stateDir: string,
  log?: (message: string) => void,
): string[] {
  const base = join(stateDir, "claude-plugins");
  const dirs: string[] = [];
  for (const plugin of plugins) {
    if (!plugin.enabled || SKIP_PLUGIN_NAMES.has(plugin.name)) continue;
    const roots = skillRoots.filter((root) => root.pluginId === plugin.id && existsSync(root.path));
    if (roots.length === 0) continue;
    const name = toAcpServerName(plugin.name);
    const dir = join(base, name);
    try {
      mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
      writeFileSync(
        join(dir, ".claude-plugin", "plugin.json"),
        `${JSON.stringify({ name, version: plugin.version ?? "0.0.0", description: plugin.description ?? plugin.name }, null, 2)}\n`,
      );
      // Claude Code 只认 <插件>/skills/<技能>/SKILL.md：逐个技能目录软链过去（skill root 可能是
      // skills 目录，也可能本身就是一个技能目录）。
      const skillsDir = join(dir, "skills");
      rmSync(skillsDir, { recursive: true, force: true });
      mkdirSync(skillsDir, { recursive: true });
      for (const root of roots) {
        const skillDirs = existsSync(join(root.path, "SKILL.md"))
          ? [root.path]
          : readdirSync(root.path, { withFileTypes: true })
              .filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && existsSync(join(root.path, entry.name, "SKILL.md")))
              .map((entry) => join(root.path, entry.name));
        for (const skillDir of skillDirs) {
          const link = join(skillsDir, basename(skillDir));
          if (!existsSync(link)) ensureSymlink(link, skillDir);
        }
      }
      dirs.push(dir);
    } catch (error) {
      log?.(`[acp-bridge] 插件 ${plugin.id} 的 Claude 外壳生成失败：${(error as Error).message}`);
    }
  }
  return dirs;
}

export function createHostSessionResources(
  input: HostSessionResourcesInput,
  log?: (message: string) => void,
): HostSessionResources {
  const claudePluginDirs = materializeClaudePluginShells(input.plugins, input.skillRoots, input.stateDir, log);
  return {
    forCwd: (cwd) => ({
      mcpServers: convertMcpServers(input.mcpServers, cwd, input.untrustedServerNames),
      claudePluginDirs,
    }),
  };
}
