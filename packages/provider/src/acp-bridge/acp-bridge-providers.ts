/**
 * acp-bridge: acp-agents.json → 合成 Provider `acp:<id>`（纯函数，无 IO）。
 *
 * 与 CLI `bootstrap/src/acp-bridge/acp-providers.ts#buildAcpProviders` 逐字段相同：
 * api.type 沿用 anthropic-messages（UI 分组只认已知 apiType）；baseUrl 指向不可达的本地占位地址，
 * 本 Provider 的回合一律由外部 ACP 引擎执行，Model 只是冻结选择载体，永不发请求。
 * 改任何字段都要同步 CLI 那份，否则 Host 与 CLI 的 Registry 会对同一选择给出不同结论。
 */
import {
  ModelConfig,
  ModelOptionSpecsConfig,
  ModelPropertiesConfig,
} from "../config/model-config.js";
import {
  ApiKeyAccessConfig,
  ProviderApiConfig,
  ProviderConfig,
} from "../config/provider-config.js";
import type { ModelId, ProviderId } from "../config/ids.js";
import type { Provider } from "../resolver.js";
import {
  ACP_BRIDGE_DEFAULT_MODEL_ID,
  ACP_BRIDGE_PROVIDER_PREFIX,
  ACP_BRIDGE_REASONING_LEVEL,
  type AcpBridgeProviderAgent,
} from "./contract.js";

const ACP_BRIDGE_PLACEHOLDER_BASE_URL = "http://127.0.0.1:9/acp-bridge-not-a-model-endpoint";

export function acpBridgeProviderId(agentId: string): string {
  return `${ACP_BRIDGE_PROVIDER_PREFIX}${agentId}`;
}

export function isAcpBridgeProviderId(providerId: string | null | undefined): boolean {
  return Boolean(providerId?.startsWith(ACP_BRIDGE_PROVIDER_PREFIX));
}

export function acpBridgeAgentModels(agent: AcpBridgeProviderAgent): string[] {
  const models = (agent.models ?? []).map((model) => model.trim()).filter(Boolean);
  return models.length > 0 ? [...new Set(models)] : [ACP_BRIDGE_DEFAULT_MODEL_ID];
}

function acpBridgeModelConfig(): ModelConfig {
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
        values: [ACP_BRIDGE_REASONING_LEVEL],
        map: '{"output_config":{"effort":reasoningLevel}}',
      },
      maxOutputTokens: { max: 64_000, map: '{"max_tokens":maxOutputTokens}' },
    }),
  });
}

export function buildAcpBridgeProviders(agents: readonly AcpBridgeProviderAgent[]): Provider[] {
  return agents.map((agent) => {
    const modelIds = acpBridgeAgentModels(agent) as ModelId[];
    const config = new ProviderConfig({
      group: "standard-personal",
      access: new ApiKeyAccessConfig({ apiKey: "acp-bridge" }),
      api: new ProviderApiConfig({
        type: "anthropic-messages",
        baseUrl: ACP_BRIDGE_PLACEHOLDER_BASE_URL,
      }),
      builtinModelIds: modelIds,
      personalModelIds: [],
      visibility: "visible",
    });
    return {
      providerId: acpBridgeProviderId(agent.id) as ProviderId,
      providerName: agent.name,
      config: config as Provider["config"],
      models: modelIds.map((modelId) => ({
        modelId,
        config: acpBridgeModelConfig() as Provider["models"][number]["config"],
      })),
    };
  });
}
