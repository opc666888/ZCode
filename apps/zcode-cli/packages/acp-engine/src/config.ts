/**
 * 读取用户配置 `<dataBaseDir>/.zcode/acp-agents.json`（格式见 docs/acp-bridge/DESIGN.md §3）。
 *
 * 契约 loadAcpAgents 是同步签名（Provider 注册在启动期同步装配），所以这里用同步读。
 * 任何格式问题都不抛出：整份文件坏了返回空列表，单个条目坏了只跳过该条；
 * 可读的错误说明通过 readAcpAgentsConfig().errors 给调用方展示或记日志。
 * 注意：errors 里只出现字段名和条目序号，绝不包含 env 的值。
 */
import { readFileSync } from "node:fs";
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

/** 读取并校验配置，带诊断信息。文件不存在时 exists=false、agents 为空、无错误。 */
export function readAcpAgentsConfig(dataBaseDir: string): AcpAgentsConfigReadResult {
  const path = acpAgentsConfigPath(dataBaseDir);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR")
      return { path, exists: false, agents: [], errors: [] };
    return {
      path,
      exists: true,
      agents: [],
      errors: [`无法读取 acp-agents.json：${code ?? (error as Error).message}`],
    };
  }
  return { path, exists: true, ...parseAcpAgentsConfig(text) };
}

/** 契约入口：只返回通过校验的智能体；文件不存在或格式错误返回 []，从不抛出。 */
export function loadAcpAgents(dataBaseDir: string): AcpAgentConfig[] {
  return readAcpAgentsConfig(dataBaseDir).agents;
}
