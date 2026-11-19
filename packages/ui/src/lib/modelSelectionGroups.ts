import {
  isZCodeAgentProvider,
  resolveModelProviderFamilySpecByProviderId,
  zcodeProviderAccountAccessSchema,
  type ZCodeProviderAccountAccess,
  type ZCodeProvider,
} from "@zcode/shared";
import { isAcpBridgeProviderId } from "@zcode/provider";
import type { ModelSelectionView } from "@zcode/services";
import type { ModelSelectGroup } from "@/ModelConfigSelect.js";
import { decodeCustomModelValue, encodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";
import { shouldShowModelVisionBadge } from "@/lib/modelVisionBadge.js";

export interface ModelProviderGroupLabelOptions {
  apiKeyLabel?: string;
  apiKeyBadgeLabel?: string;
  codingPlanLabel?: string;
  codingPlanBadgeLabel?: string;
  startPlanLabel?: string;
  startPlanBadgeLabel?: string;
  teamPlanBadgeLabel?: string;
  teamPlanFallbackLabel?: string;
}

function supportsRegistryApiFormat(
  selectedProvider: ZCodeProvider,
  apiFormat: string | null | undefined,
): boolean {
  if (!apiFormat) return false;
  // 仅剩 glm（ZCode Agent）provider；三方 CLI 的 api format 差异已随 provider 下线。
  return isZCodeAgentProvider(selectedProvider);
}

export interface RegistryModelSelectGroupOptions {
  /**
   * acp-bridge: ACP 智能体只能驱动整条会话回合；ZCode 子智能体、动态工作流等由 GLM 运行时
   * 自己发模型请求的入口必须排除它们，否则会选到一个永不可请求的占位 Model。
   */
  excludeAcpBridge?: boolean;
}

export function buildRegistryModelSelectGroups(
  selectedProvider: ZCodeProvider,
  view: ModelSelectionView,
  labels: ModelProviderGroupLabelOptions = {},
  options: RegistryModelSelectGroupOptions = {},
): ModelSelectGroup[] {
  return view.providers.flatMap((provider) => {
    // acp-bridge: ACP Provider 按 agent 独立成组（名=agent.name），不受 api format 过滤，
    // 不挂 API/套餐角标（它没有计费、升级或账号连接概念）。
    const acpBridge = isAcpBridgeProviderId(provider.providerId);
    if (acpBridge && options.excludeAcpBridge) return [];
    if (!acpBridge && !supportsRegistryApiFormat(selectedProvider, provider.config.api?.type)) {
      return [];
    }

    const accountAccess = acpBridge
      ? null
      : zcodeProviderAccountAccessSchema.safeParse(provider.config.access);
    const accountPresentation = accountAccess?.success
      ? getRegistryAccountProviderGroupPresentation(provider.providerId, accountAccess.data, labels)
      : null;

    // 合并菜单仍需区分同名供应商的接入方式；API 标识直接来自 access，不能从名称猜测。
    const labelBadge = acpBridge
      ? undefined
      : (accountPresentation?.labelBadge ??
        (provider.config.access?.type === "api-key" ||
        provider.config.access?.type === "zhipu-coding-plan-api-key"
          ? (labels.apiKeyBadgeLabel ?? "API")
          : undefined));

    return [
      {
        key: `registry-provider:${provider.providerId}`,
        label: accountPresentation?.label || provider.providerName?.trim() || provider.providerId,
        ...(provider.config.logo ? { logo: provider.config.logo } : {}),
        ...(labelBadge ? { labelBadge } : {}),
        ...(accountPresentation ? { directItems: true } : {}),
        items: provider.models.map(({ modelId, config }) => ({
          key: `registry-provider:${provider.providerId}:${modelId}`,
          value: encodeCustomModelValue(provider.providerId, modelId),
          name: modelId,
          ...(shouldShowModelVisionBadge(
            modelId,
            config.properties?.inputFormat?.supportsImage,
            provider.config.access,
          )
            ? { supportsVisionInput: true }
            : {}),
        })),
      },
    ];
  });
}

function getRegistryAccountProviderGroupPresentation(
  providerId: string,
  access: ZCodeProviderAccountAccess,
  labels: ModelProviderGroupLabelOptions,
): Pick<ModelSelectGroup, "label" | "labelBadge"> {
  const familySpec = resolveModelProviderFamilySpecByProviderId(providerId);
  const label = familySpec?.label ?? providerId;
  if (access.mode === "start-plan") {
    return { label: "Start Plan", labelBadge: labels.startPlanBadgeLabel ?? "Free" };
  }
  if (access.mode === "team-coding-plan") {
    return { label, labelBadge: labels.teamPlanBadgeLabel ?? "Team" };
  }
  return { label, labelBadge: labels.codingPlanBadgeLabel ?? "Individual" };
}

export function resolveModelDisplayName(
  modelGroups: readonly ModelSelectGroup[],
  value: string,
): string | null {
  for (const group of modelGroups) {
    const matched = group.items.find((item) => item.value === value);
    if (matched) return matched.name;
  }

  return decodeCustomModelValue(value)?.modelName ?? null;
}
