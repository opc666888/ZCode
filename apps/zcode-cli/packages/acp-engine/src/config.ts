/**
 * 读取用户配置 `<dataBaseDir>/.zcode/acp-agents.json`（格式见 docs/acp-bridge/DESIGN.md §3）。
 *
 * 契约 loadAcpAgents 是同步签名（Provider 注册在启动期同步装配），所以这里用同步读。
 * 任何格式问题都不抛出：整份文件坏了返回空列表，单个条目坏了只跳过该条；
 * 可读的错误说明通过 readAcpAgentsConfig().errors 给调用方展示或记日志。
 * 注意：errors 里只出现字段名和条目序号，绝不包含 env 的值。
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AcpAgentConfig } from "./types.js";

export interface AcpAgentsConfigReadResult {
  /** 配置文件绝对路径。 */
  path: string;
  /** 文件是否存在。 */
  exists: boolean;
  /** 通过校验的智能体。 */
  agents: AcpAgentConfig[];
  /** 人能看懂的问题列表（中文），为空表示没有问题。 */
  errors: string[];
  /** agents 里是否包含内置的默认 Claude Code（用户没有自己配置任何智能体时自动提供）。 */
  builtin?: boolean;
}

/** 内置默认智能体的 id（provider id 即 `acp:claude`）。 */
export const BUILTIN_CLAUDE_AGENT_ID = "claude";
/** 让安装包或用户指定适配器入口（claude-agent-acp 的 dist/index.js）。 */
export const BUILTIN_CLAUDE_ENTRY_ENV = "ZCODE_ACP_CLAUDE_ENTRY";
/** 默认在模型选择器里列出的模型；`default` = 用 Claude Code 自己的默认模型。 */
export const BUILTIN_CLAUDE_MODELS = ["default", "opus", "sonnet", "haiku"] as const;

const CLAUDE_ACP_PACKAGE_ENTRY = [
  "node_modules",
  "@agentclientprotocol",
  "claude-agent-acp",
  "dist",
  "index.js",
];

export interface BuiltinAgentProbe {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  execPath?: string;
  exists?: (path: string) => boolean;
}

/**
 * 找 Claude Code 的 ACP 适配器入口，按优先级：
 *   1. 环境变量 ZCODE_ACP_CLAUDE_ENTRY（安装包把随包的适配器路径放这里）
 *   2. 数据目录 `<dataBaseDir>/.zcode/acp-agents/claude/`（首次使用时安装到这里）
 *   3. 本机 Zed 已装的 Claude Agent（装过 Zed 的用户直接复用，不重复下载）
 * 都没有返回 undefined：此时不提供内置智能体，界面按「还没装 Claude Code 适配器」处理。
 */
export function resolveBuiltinClaudeEntry(
  dataBaseDir: string,
  probe: BuiltinAgentProbe = {},
): string | undefined {
  const env = probe.env ?? process.env;
  const platform = probe.platform ?? process.platform;
  const exists = probe.exists ?? existsSync;
  let home = probe.home;
  if (home === undefined) {
    try {
      home = homedir();
    } catch {
      home = "";
    }
  }
  const candidates: string[] = [];
  const fromEnv = env[BUILTIN_CLAUDE_ENTRY_ENV]?.trim();
  if (fromEnv) candidates.push(fromEnv);
  candidates.push(join(dataBaseDir, ".zcode", "acp-agents", "claude", ...CLAUDE_ACP_PACKAGE_ENTRY));
  const zedTail = ["external_agents", "registry", "npx", "claude-acp", ...CLAUDE_ACP_PACKAGE_ENTRY];
  if (platform === "darwin" && home)
    candidates.push(join(home, "Library", "Application Support", "Zed", ...zedTail));
  else if (platform === "win32") {
    const local = env.LOCALAPPDATA?.trim() || (home ? join(home, "AppData", "Local") : "");
    if (local) candidates.push(join(local, "Zed", ...zedTail));
  } else if (home) {
    const data = env.XDG_DATA_HOME?.trim() || join(home, ".local", "share");
    candidates.push(join(data, "zed", ...zedTail));
  }
  return candidates.find((candidate) => {
    try {
      return exists(candidate);
    } catch {
      return false;
    }
  });
}

/**
 * 内置默认智能体：用当前运行时（Node 或以 Node 模式运行的 Electron）直接跑适配器，
 * 账号用 Claude Code 默认的配置目录（~/.claude）。找不到适配器返回 undefined。
 */
export function builtinClaudeAgent(
  dataBaseDir: string,
  probe: BuiltinAgentProbe = {},
): AcpAgentConfig | undefined {
  // ZCODE_ACP_BUILTIN=0：完全关闭内置智能体（只想用自己配置的启动器时用）。
  if ((probe.env ?? process.env).ZCODE_ACP_BUILTIN === "0") return undefined;
  const entry = resolveBuiltinClaudeEntry(dataBaseDir, probe);
  if (!entry) return undefined;
  return {
    id: BUILTIN_CLAUDE_AGENT_ID,
    name: "Claude Code",
    command: probe.execPath ?? process.execPath,
    args: [entry],
    // CLI 由桌面端的 Electron 以 Node 模式拉起时，子进程也要保持 Node 模式；对普通 Node 无影响。
    // ZCODE_ACP_AGENT_HOME：宿主把 HOME 隔离（沙箱、开发隔离）时，指回真实家目录——
    // Claude Code 的登录凭据在系统钥匙串里，钥匙串位置跟 HOME 走，HOME 不对就会报「需要授权」。
    env: {
      ELECTRON_RUN_AS_NODE: "1",
      ...((probe.env ?? process.env).ZCODE_ACP_AGENT_HOME?.trim()
        ? { HOME: (probe.env ?? process.env).ZCODE_ACP_AGENT_HOME!.trim() }
        : {}),
    },
    models: [...BUILTIN_CLAUDE_MODELS],
  };
}

/** 智能体 id 会拼进 provider id `acp:<id>`，只允许安全字符。 */
const AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function acpAgentsConfigPath(dataBaseDir: string): string {
  return join(dataBaseDir, ".zcode", "acp-agents.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) return undefined;
  return value as string[];
}

function parseAgent(
  raw: unknown,
  index: number,
  seen: Set<string>,
  errors: string[],
): AcpAgentConfig | undefined {
  const where = `agents[${index}]`;
  if (!isRecord(raw)) {
    errors.push(`${where} 不是对象，已跳过`);
    return undefined;
  }
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!AGENT_ID_PATTERN.test(id)) {
    errors.push(
      `${where}.id 缺失或含非法字符（只允许字母、数字、点、下划线、短横线，最长 64），已跳过`,
    );
    return undefined;
  }
  if (seen.has(id)) {
    errors.push(`${where}.id「${id}」重复，已跳过`);
    return undefined;
  }
  const command = typeof raw.command === "string" ? raw.command.trim() : "";
  if (!command) {
    errors.push(`${where}（${id}）缺少 command，已跳过`);
    return undefined;
  }
  let args: string[] | undefined;
  if (raw.args !== undefined) {
    args = stringArray(raw.args);
    if (!args) {
      errors.push(`${where}（${id}）的 args 必须是字符串数组，已跳过`);
      return undefined;
    }
  }
  let env: Record<string, string> | undefined;
  if (raw.env !== undefined) {
    if (!isRecord(raw.env) || Object.values(raw.env).some((v) => typeof v !== "string")) {
      errors.push(`${where}（${id}）的 env 必须是「字符串 → 字符串」对象，已跳过`);
      return undefined;
    }
    env = { ...(raw.env as Record<string, string>) };
  }
  let models: string[] | undefined;
  if (raw.models !== undefined) {
    const list = stringArray(raw.models);
    if (!list) {
      errors.push(`${where}（${id}）的 models 必须是字符串数组，已忽略该字段`);
    } else {
      const cleaned = [...new Set(list.map((m) => m.trim()).filter((m) => m.length > 0))];
      if (cleaned.length > 0) models = cleaned;
    }
  }
  const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : id;
  seen.add(id);
  return {
    id,
    name,
    command,
    ...(args ? { args } : {}),
    ...(env ? { env } : {}),
    ...(models ? { models } : {}),
  };
}

/** 解析配置文件文本；空文本视为「没有配置」。 */
export function parseAcpAgentsConfig(text: string): { agents: AcpAgentConfig[]; errors: string[] } {
  if (text.trim() === "") return { agents: [], errors: [] };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return { agents: [], errors: [`acp-agents.json 不是合法 JSON：${(error as Error).message}`] };
  }
  if (!isRecord(data) || !Array.isArray(data.agents)) {
    return { agents: [], errors: ['acp-agents.json 顶层必须是 { "agents": [...] }'] };
  }
  const errors: string[] = [];
  const seen = new Set<string>();
  const agents: AcpAgentConfig[] = [];
  data.agents.forEach((raw, index) => {
    const agent = parseAgent(raw, index, seen, errors);
    if (agent) agents.push(agent);
  });
  return { agents, errors };
}

/**
 * 读取并校验配置，带诊断信息。文件不存在时 exists=false、无错误。
 * 用户一个智能体都没配（没有文件、空文件或条目全坏）时，自动提供内置的默认 Claude Code，
 * 做到「装上就能用」；用户只要自己配了任何一个智能体，就完全按用户的来，不再追加内置项
 * （多账号用户往往给每个账号配了专门的启动器，不能再混进一个走默认账号的入口）。
 */
export function readAcpAgentsConfig(
  dataBaseDir: string,
  probe: BuiltinAgentProbe = {},
): AcpAgentsConfigReadResult {
  const path = acpAgentsConfigPath(dataBaseDir);
  const withBuiltin = (result: AcpAgentsConfigReadResult): AcpAgentsConfigReadResult => {
    if (result.agents.length > 0) return result;
    const builtin = builtinClaudeAgent(dataBaseDir, probe);
    return builtin ? { ...result, agents: [builtin], builtin: true } : result;
  };
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR")
      return withBuiltin({ path, exists: false, agents: [], errors: [] });
    return withBuiltin({
      path,
      exists: true,
      agents: [],
      errors: [`无法读取 acp-agents.json：${code ?? (error as Error).message}`],
    });
  }
  return withBuiltin({ path, exists: true, ...parseAcpAgentsConfig(text) });
}

/** 契约入口：只返回可用的智能体（含内置默认项）；从不抛出。 */
export function loadAcpAgents(dataBaseDir: string): AcpAgentConfig[] {
  return readAcpAgentsConfig(dataBaseDir).agents;
}
