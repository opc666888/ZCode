/**
 * acp-agents.json → 合成 Provider `acp:<id>`（DESIGN §3/§5.1-4）。
 *
 * api.type 沿用 anthropic-messages：UI 分组过滤（modelSelectionGroups / composerPlanGroups）
 * 只认已知 apiType，新增枚举会被挡掉。baseUrl 指向不可达的本地占位地址：
 * 本 Provider 的回合一律由外部引擎执行，Model 只是 Core 的冻结选择载体，永不发请求；
 * 万一有旁路误调用，会立即以连接失败暴露，而不是把内容发到任何远端。
 */
import {
  ApiKeyAccessConfig,
  ModelConfig,
  ModelOptionSpecsConfig,
  ModelPropertiesConfig,
  ProviderApiConfig,
  ProviderConfig,
  ProviderRegistry,
  type ModelId,
  type Provider,
  type ProviderId,
} from "@zcode/provider";
import { ACP_DEFAULT_MODEL_LABEL, isLegacyDefaultModelLabel } from "@zcode/acp-engine";
import type { ProviderRegistryModelSource } from "../app/provider-registry-model-runtime.js";
import type { AcpBridgeAgentConfig } from "./contract.js";

export const ACP_PROVIDER_PREFIX = "acp:";
export const ACP_DEFAULT_MODEL_ID = "default";
/** ACP 智能体没有 ZCode 的思考档位；唯一取值让 Selection 校验恒定通过。 */
export const ACP_REASONING_LEVEL = "default";
/** 思考强度档位：对应 Claude Code 的 effort；`default` = 不设置，用智能体自己的默认值。Host 侧同名常量必须一致。 */
export const ACP_REASONING_LEVELS = ["default", "low", "medium", "high", "xhigh", "max"] as const;
const ACP_PLACEHOLDER_BASE_URL = "http://127.0.0.1:9/acp-bridge-not-a-model-endpoint";

export function acpProviderId(agentId: string): string {
  return `${ACP_PROVIDER_PREFIX}${agentId}`;
}

export function acpAgentIdOf(providerId: string | undefined): string | undefined {
  return providerId?.startsWith(ACP_PROVIDER_PREFIX)
    ? providerId.slice(ACP_PROVIDER_PREFIX.length)
    : undefined;
}

export function acpAgentModels(agent: AcpBridgeAgentConfig): string[] {
  const models = (agent.models ?? []).map((model) => model.trim()).filter(Boolean);
  return models.length > 0 ? [...new Set(models)] : [ACP_DEFAULT_MODEL_ID];
}

function acpModelConfig(): ModelConfig {
  return new ModelConfig({
    enabled: true,
    properties: new ModelPropertiesConfig({
      requiresMfjsToolSchema: false,
      contextWindow: 200_000,
      inputFormat: {
        supportsText: true,
        supportsImage: true,
        supportsVideo: false,
        supportsAudio: false,
        supportsPdf: false,
      },
      outputFormat: { supportsText: true },
      supportsToolCall: true,
      supportsJsonSchemaOutput: false,
      supportsNativeWebSearch: false,
      supportsMidConversationSystem: false,
    }),
    optionSpecs: new ModelOptionSpecsConfig({
      // 映射只为通过配置校验；该 Model 不会真正发请求。
      reasoningLevel: {
        values: [...ACP_REASONING_LEVELS],
        map: '{"output_config":{"effort":reasoningLevel}}',
      },
      maxOutputTokens: { max: 64_000, map: '{"max_tokens":maxOutputTokens}' },
    }),
  });
}

export function buildAcpProviders(agents: readonly AcpBridgeAgentConfig[]): Provider[] {
  return agents.map((agent) => {
    const modelIds = acpAgentModels(agent) as ModelId[];
    const config = new ProviderConfig({
      group: "standard-personal",
      access: new ApiKeyAccessConfig({ apiKey: "acp-bridge" }),
      api: new ProviderApiConfig({ type: "anthropic-messages", baseUrl: ACP_PLACEHOLDER_BASE_URL }),
      builtinModelIds: modelIds,
      personalModelIds: [],
      visibility: "visible",
    });
    return {
      providerId: acpProviderId(agent.id) as ProviderId,
      providerName: agent.name,
      config: config as Provider["config"],
      models: modelIds.map((modelId) => ({
        modelId,
        config: acpModelConfig() as Provider["models"][number]["config"],
      })),
    };
  });
}

/** ACP 选择补齐思考档位（缺省或不认识的值按 default）：Registry 校验与 Model Factory 都要求完整执行选择。 */
export function completeAcpSelection<T extends { providerId: string; options?: Record<string, unknown> }>(
  selection: T,
): T {
  if (acpAgentIdOf(selection.providerId) === undefined) return selection;
  const level = selection.options?.reasoningLevel;
  if (typeof level === "string" && (ACP_REASONING_LEVELS as readonly string[]).includes(level))
    return selection;
  return { ...selection, options: { ...selection.options, reasoningLevel: ACP_REASONING_LEVEL } };
}

/**
 * 把选择里的模型换成这个 Provider 现在真有的：
 *   - 模型还在清单里：不动；
 *   - 是旧写法（发给智能体的原值，如 default / opus）：换成对应的显示名；
 *   - 都对不上（清单随版本变了）：退到清单第一个（默认）。
 * 这样改用带版本号的显示名之后，以前存下的任务和草稿不会因为「模型不存在」打不开。
 */
export function normalizeAcpSelection<
  T extends { providerId: string; modelId?: string; options?: Record<string, unknown> },
>(selection: T, providers: readonly Provider[], agents: readonly AcpBridgeAgentConfig[] = []): T {
  const agentId = acpAgentIdOf(selection.providerId);
  if (agentId === undefined) return selection;
  const completed = completeAcpSelection(selection);
  const provider = providers.find((candidate) => candidate.providerId === selection.providerId);
  if (!provider || provider.models.length === 0) return completed;
  const modelIds = provider.models.map((model) => model.modelId as string);
  if (completed.modelId !== undefined && modelIds.includes(completed.modelId)) return completed;
  const values = (agents.find((agent) => agent.id === agentId) as { modelValues?: Record<string, string> } | undefined)
    ?.modelValues;
  const byValue =
    (isLegacyDefaultModelLabel(completed.modelId) && modelIds.includes(ACP_DEFAULT_MODEL_LABEL)
      ? ACP_DEFAULT_MODEL_LABEL
      : undefined) ??
    (values ? modelIds.find((label) => values[label] === completed.modelId) : undefined);
  return { ...completed, modelId: byValue ?? modelIds[0] };
}

/**
 * 在进程 Registry 之上叠加 ACP Provider：基础 Registry 的变化照常透传，ACP 条目只读。
 * 同名冲突时以基础 Registry 为准（ACP id 带 `acp:` 前缀，正常不会冲突）。
 */
export function withAcpProviders(
  base: ProviderRegistryModelSource,
  providers: readonly Provider[],
  agents: readonly AcpBridgeAgentConfig[] = [],
): ProviderRegistryModelSource {
  if (providers.length === 0) return base;
  const acp = new ProviderRegistry(providers);
  const isAcp = (providerId: string) =>
    acpAgentIdOf(providerId) !== undefined && acp.getProvider(providerId as ProviderId) !== undefined;
  return {
    getView: () => {
      const view = base.getView();
      return Object.freeze({
        revision: view.revision,
        providers: Object.freeze([...view.providers, ...acp.getView().providers]),
      });
    },
    getProvider: (providerId) =>
      isAcp(providerId) ? acp.getProvider(providerId as ProviderId) : base.getProvider(providerId),
    getModel: (providerId, modelId) =>
      isAcp(providerId)
        ? acp.getModel(providerId as ProviderId, modelId as ModelId)
        : base.getModel(providerId, modelId),
    validateSelection: (selection) =>
      isAcp(selection.providerId)
        ? // UI 不展示 ACP 思考档位；缺省时补唯一取值，避免 reasoning-level-missing。
          acp.validateSelection(normalizeAcpSelection(selection, providers, agents))
        : base.validateSelection(selection),
    onDidChange: (listener) => base.onDidChange(listener),
  };
}
