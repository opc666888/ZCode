/**
 * 智能体的模型清单：直接用适配器自己报的（ACP `session/new` 返回的 configOptions 里 id = "model" 那一项），
 * 界面上显示带版本号的名字（Opus 5.5、Fable 5.2…），「默认」写明当前实际是哪个模型。
 *
 * 清单会随 Claude Code 版本和账号套餐变化，所以每次建会话后把它缓存到
 * `<数据目录>/.zcode/acp-bridge/models-<智能体 id>.json`，下次启动读缓存；还没有缓存时用下面的内置清单。
 * 界面里的模型 id 就是显示名（ZCode 的选择器直接显示 id），真正发给智能体的值在 modelValues 里。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface AgentModelOption {
  /** 发给智能体的值，如 opus、claude-fable-5-2、default。 */
  value: string;
  /** 智能体给的名字，如 Opus 5.5。 */
  name: string;
  description?: string;
}

/** 还没有缓存时的清单（2026-11-20 从 claude-agent-acp 实测得到，顺序同适配器）。 */
export const FALLBACK_CLAUDE_MODELS: readonly AgentModelOption[] = Object.freeze([
  { value: "default", name: "Default (recommended)", description: "Sonnet 5.5" },
  { value: "opus", name: "Opus 5.5" },
  { value: "claude-fable-5-2", name: "Fable 5.2" },
  { value: "sonnet", name: "Sonnet 5.5" },
  { value: "haiku", name: "Haiku 5.5" },
  { value: "fable", name: "Fable 5.1" },
]);

const MAX_MODELS = 40;

export function modelCachePath(dataBaseDir: string, agentId: string): string {
  return join(dataBaseDir, ".zcode", "acp-bridge", `models-${agentId}.json`);
}

function cleanOptions(raw: unknown): AgentModelOption[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: AgentModelOption[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const { value, name, description } = item as Record<string, unknown>;
    if (typeof value !== "string" || !value.trim() || value.length > 120 || seen.has(value)) continue;
    seen.add(value);
    out.push({
      value,
      name: typeof name === "string" && name.trim() ? name.trim().slice(0, 80) : value,
      ...(typeof description === "string" && description.trim()
        ? { description: description.trim().slice(0, 120) }
        : {}),
    });
    if (out.length >= MAX_MODELS) break;
  }
  return out;
}

/** 从 session/new、session/load、set_config_option 的返回里取模型清单；没有就返回 []。 */
export function modelOptionsFromConfigOptions(configOptions: unknown): AgentModelOption[] {
  if (!Array.isArray(configOptions)) return [];
  const model = configOptions.find(
    (option) => option && typeof option === "object" && (option as { id?: unknown }).id === "model",
  ) as { options?: unknown } | undefined;
  return cleanOptions(model?.options);
}

/**
 * 显示名：`default` 显示成「默认（Sonnet 5.5）」这样说清楚实际模型；其余用智能体给的名字。
 * 返回界面用的模型列表和「显示名 → 发给智能体的值」对照表（显示名重复时后者加上原值区分）。
 */
export function presentModels(options: readonly AgentModelOption[]): {
  models: string[];
  modelValues: Record<string, string>;
} {
  const models: string[] = [];
  const modelValues: Record<string, string> = {};
  for (const option of options) {
    let label =
      option.value === "default"
        ? option.description && !/^default/i.test(option.description)
          ? `默认（${option.description}）`
          : "默认"
        : option.name;
    if (label in modelValues) label = `${label}（${option.value}）`;
    if (label in modelValues) continue;
    models.push(label);
    modelValues[label] = option.value;
  }
  return { models, modelValues };
}

export function readModelCache(dataBaseDir: string, agentId: string): AgentModelOption[] {
  try {
    const data = JSON.parse(readFileSync(modelCachePath(dataBaseDir, agentId), "utf8")) as {
      options?: unknown;
    };
    return cleanOptions(data?.options);
  } catch {
    return [];
  }
}

/** 写缓存（原子替换）；写不了不影响回合。stateDir = `<数据目录>/.zcode/acp-bridge`。 */
export function writeModelCache(stateDir: string, agentId: string, options: AgentModelOption[]): void {
  if (options.length === 0) return;
  try {
    mkdirSync(stateDir, { recursive: true });
    const file = join(stateDir, `models-${agentId}.json`);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, options }));
    renameSync(tmp, file);
  } catch {
    // 缓存只是为了下次启动显示得更准，失败就用内置清单
  }
}
