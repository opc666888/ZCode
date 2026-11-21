import { isAcpBridgeProviderId } from "./acp-bridge/acp-bridge-providers.js";
import { ACP_BRIDGE_REASONING_LEVEL } from "./acp-bridge/contract.js";
import {
  validateModelSelectionOptions,
  type ModelSelection,
  type ProviderRegistryView,
} from "./registry.js";

export type InitialModelSelectionResolution =
  | {
      readonly source: "configured-default" | "registry-fallback";
      readonly selection: ModelSelection;
    }
  | { readonly source: "none" };

interface ModelSelectionCompletionView {
  readonly providers: readonly {
    readonly providerId: string;
    readonly models: readonly {
      readonly modelId: string;
      readonly config: {
        readonly optionSpecs: {
          readonly reasoningLevel: { readonly values: readonly string[] };
        };
      };
    }[];
  }[];
}

/**
 * acp-bridge: 外部智能体的模型清单是它自己报的（带版本号的显示名），账号登录前后、版本升级后都可能变。
 * 存下来的选择对不上清单时，不让用户卡在「请选择模型」：同一个智能体还在，就退到它清单的第一个（默认）。
 * 只对 `acp:` Provider 生效；其他 Provider 的失效选择仍按原规则处理。
 */
function remapStaleAcpSelection<T extends ModelSelection>(
  registry: ModelSelectionCompletionView,
  selection: T,
): T {
  if (!isAcpBridgeProviderId(selection.providerId)) return selection;
  const provider = registry.providers.find(
    (candidate) => candidate.providerId === selection.providerId,
  );
  const first = provider?.models[0];
  if (!first || provider.models.some((model) => model.modelId === selection.modelId))
    return selection;
  return { ...selection, modelId: first.modelId };
}

export function resolveInitialModelSelection(input: {
  readonly configuredDefault?: ModelSelection;
  readonly registry: ProviderRegistryView;
}): InitialModelSelectionResolution {
  if (input.configuredDefault) {
    input = {
      ...input,
      configuredDefault: remapStaleAcpSelection(input.registry, input.configuredDefault),
    };
  }
  // 这里只构造 Host 的初始推荐，不解析已有会话意图。失效默认是可丢弃偏好，
  // 应继续按 Registry 顺序推荐；不能把历史选择留空的规则误用于新草稿初始化。
  if (input.configuredDefault) {
    if (isSelectable(input.registry, input.configuredDefault)) {
      return {
        source: "configured-default",
        selection: freezeSelection(input.configuredDefault),
      };
    }
  }

  // 仅用于全新草稿的 Host 初始推荐；历史未绑定状态不能进入这个初始化分支。
  for (const provider of input.registry.providers) {
    if (provider.config.visibility === "hidden") continue;
    for (const model of provider.models) {
      const selection = completeNewModelSelection(input.registry, {
        providerId: provider.providerId,
        modelId: model.modelId,
      });
      if (selection) return { source: "registry-fallback", selection: freezeSelection(selection) };
    }
  }
  return { source: "none" };
}

/** 仅在用户主动选模型或全新初始化时构造最高档；不能用于恢复/重解析已有选择。 */
export function completeNewModelSelection(
  registry: ModelSelectionCompletionView,
  selection: ModelSelection,
): ModelSelection | undefined {
  const model = registry.providers
    .find((provider) => provider.providerId === selection.providerId)
    ?.models.find((candidate) => candidate.modelId === selection.modelId);
  const values = model?.config.optionSpecs.reasoningLevel.values;
  // acp-bridge: 外部智能体（Claude Code）的档位里有 "default" = 用它自己的设置；新选择默认用它，
  // 不能按「最高档」替用户把思考强度拉满（白白多耗额度）。其他 Provider 没有这一档，行为不变。
  const reasoningLevel =
    isAcpBridgeProviderId(selection.providerId) && values?.includes(ACP_BRIDGE_REASONING_LEVEL)
      ? ACP_BRIDGE_REASONING_LEVEL
      : values?.at(-1);
  if (!reasoningLevel) return undefined;
  return {
    providerId: selection.providerId,
    modelId: selection.modelId,
    options: { reasoningLevel },
  };
}

/**
 * 规范化一份待提交的 Selection。
 * 已有选择缺失或失效时只保留模型身份，等待用户选择档位；主动选模型另走 completion。
 * 任何执行入口都必须在此之后再次确认 Selection 完整，不能静默补档位。
 */
export function normalizeModelSelection(
  registry: ModelSelectionCompletionView,
  selection: ModelSelection,
): ModelSelection | undefined {
  selection = remapStaleAcpSelection(registry, selection);
  const model = registry.providers
    .find((provider) => provider.providerId === selection.providerId)
    ?.models.find((candidate) => candidate.modelId === selection.modelId);
  if (!model) return undefined;
  const values = model.config.optionSpecs.reasoningLevel.values;
  const reasoningLevel = selection.options?.reasoningLevel;
  if (reasoningLevel !== undefined && values.includes(reasoningLevel)) return selection;
  return {
    providerId: selection.providerId,
    modelId: selection.modelId,
  };
}

function isSelectable(registry: ProviderRegistryView, selection: ModelSelection): boolean {
  const provider = registry.providers.find(
    (candidate) => candidate.providerId === selection.providerId,
  );
  if (provider?.config.visibility === "hidden") return false;
  const model = provider?.models.find((candidate) => candidate.modelId === selection.modelId);
  if (!model) return false;
  return validateModelSelectionOptions(model, selection).ok;
}

function freezeSelection(selection: ModelSelection): ModelSelection {
  return Object.freeze({
    providerId: selection.providerId,
    modelId: selection.modelId,
    ...(selection.options ? { options: Object.freeze({ ...selection.options }) } : {}),
  });
}
