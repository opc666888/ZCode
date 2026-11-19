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
import type { ProviderRegistryModelSource } from "../app/provider-registry-model-runtime.js";
import type { AcpBridgeAgentConfig } from "./contract.js";

export const ACP_PROVIDER_PREFIX = "acp:";
export const ACP_DEFAULT_MODEL_ID = "default";
/** ACP 智能体没有 ZCode 的思考档位；唯一取值让 Selection 校验恒定通过。 */
export const ACP_REASONING_LEVEL = "default";
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
        values: [ACP_REASONING_LEVEL],
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

/** ACP 选择补齐唯一思考档位：Registry 校验与 Model Factory 都要求完整执行选择。 */
export function completeAcpSelection<T extends { providerId: string; options?: Record<string, unknown> }>(
  selection: T,
): T {
  if (acpAgentIdOf(selection.providerId) === undefined) return selection;
  if (selection.options?.reasoningLevel === ACP_REASONING_LEVEL) return selection;
  return { ...selection, options: { ...selection.options, reasoningLevel: ACP_REASONING_LEVEL } };
}

/**
 * 在进程 Registry 之上叠加 ACP Provider：基础 Registry 的变化照常透传，ACP 条目只读。
 * 同名冲突时以基础 Registry 为准（ACP id 带 `acp:` 前缀，正常不会冲突）。
 */
export function withAcpProviders(
  base: ProviderRegistryModelSource,
  providers: readonly Provider[],
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
          acp.validateSelection(completeAcpSelection(selection))
        : base.validateSelection(selection),
    onDidChange: (listener) => base.onDidChange(listener),
  };
}
