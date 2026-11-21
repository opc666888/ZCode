import { isAcpBridgeProviderId } from "@zcode/provider";
import type { ModelSelectionView } from "@zcode/services";

export interface ProviderAvailabilityState {
  readonly source: "registry";
  readonly hydrated: boolean;
  readonly providerCount: number;
  readonly hasUsableProvider: boolean;
  /** acp-bridge: 有至少一个带模型的 ACP 智能体 Provider（`acp:<id>`），它不依赖 Z.AI 账号或区域。 */
  readonly hasUsableAcpBridgeProvider: boolean;
}

export function resolveProviderAvailabilityState(params: {
  modelSelectionView: ModelSelectionView | null;
}): ProviderAvailabilityState {
  const providers = params.modelSelectionView?.providers ?? [];
  return {
    source: "registry",
    hydrated: params.modelSelectionView !== null,
    providerCount: providers.length,
    hasUsableProvider:
      params.modelSelectionView !== null &&
      providers.some((provider) => provider.models.length > 0),
    hasUsableAcpBridgeProvider: providers.some(
      (provider) => isAcpBridgeProviderId(provider.providerId) && provider.models.length > 0,
    ),
  };
}
