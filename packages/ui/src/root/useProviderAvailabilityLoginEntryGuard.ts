import { useCallback, useEffect, useRef, useState } from "react";
import type { UserInfo } from "@zcode/shared";
import type { ModelSelectionView } from "@zcode/services";
import { resolveProviderAvailabilityState } from "@/lib/modelProviderAvailability.js";
import { logger } from "@/logger.js";

export interface ProviderAvailabilityLoginEntryGuardResult {
  hasUsableProvider: boolean;
  providerCount: number;
  shouldOpenLoginEntry: boolean;
}

/**
 * 启动登录入口判定（纯函数，守卫与测试共用）。
 * 未选区域或「未登录且无可用模型」时打开登录/区域选择页。
 * acp-bridge: 已配置可用 ACP 智能体时不强制进入「登录 Z.AI」/区域选择——ACP 会话不需要
 * Z.AI 账号或区域；用户仍可从设置手动登录。
 */
export function resolveShouldOpenProviderLoginEntry(params: {
  providerFamilyDomain: string | null | undefined;
  hasUser: boolean;
  hasUsableProvider: boolean;
  hasUsableAcpBridgeProvider: boolean;
}): boolean {
  if (params.hasUsableAcpBridgeProvider) return false;
  return !params.providerFamilyDomain || (!params.hasUser && !params.hasUsableProvider);
}

export function useProviderAvailabilityLoginEntryGuard({
  enabled = true,
  user,
  isRestoringOAuthSession,
  providerFamilyDomain,
  modelSelectionView,
  modelSelectionError,
  refreshProviderState,
  readModelSelectionView,
  setLoginEntryOpen,
}: {
  enabled?: boolean;
  user: UserInfo | null;
  isRestoringOAuthSession: boolean;
  providerFamilyDomain: string | null | undefined;
  modelSelectionView: ModelSelectionView | null;
  modelSelectionError?: Error;
  refreshProviderState: () => Promise<void>;
  readModelSelectionView: () => Promise<ModelSelectionView>;
  setLoginEntryOpen: (open: boolean) => void;
}) {
  const [startupCheckCompleted, setStartupCheckCompleted] = useState(!enabled);
  const startupCheckCompletedRef = useRef(false);
  const providerAvailabilityHydrated = modelSelectionView !== null;

  const syncLoginEntryWithProviderAvailability = useCallback(
    async (options: { forceRefresh?: boolean; reason: string }) => {
      if (!enabled) {
        return {
          hasUsableProvider: true,
          providerCount: modelSelectionView?.providers.length ?? 0,
          shouldOpenLoginEntry: false,
        } satisfies ProviderAvailabilityLoginEntryGuardResult;
      }

      if (options.forceRefresh) {
        await refreshProviderState();
      }

      const refreshedView = options.forceRefresh
        ? await readModelSelectionView()
        : modelSelectionView;
      const availability = resolveProviderAvailabilityState({ modelSelectionView: refreshedView });
      const { hasUsableProvider, hasUsableAcpBridgeProvider, providerCount } = availability;
      const shouldOpenLoginEntry = resolveShouldOpenProviderLoginEntry({
        providerFamilyDomain,
        hasUser: Boolean(user),
        hasUsableProvider,
        hasUsableAcpBridgeProvider,
      });

      // 未登录且没有可用模型配置时必须引导用户连接账号或填写 API Key。
      // 启动检查、API Key 设置回流等入口统一走这里，避免各处复制判断后语义分叉。
      logger.info("[Root] provider 可用性登录入口守卫完成检查", {
        reason: options.reason,
        source: availability.source,
        providerCount,
        hasUsableProvider,
        hasUsableAcpBridgeProvider,
        hasUser: Boolean(user),
        hasProviderFamilyDomain: Boolean(providerFamilyDomain),
        shouldOpenLoginEntry,
      });
      setLoginEntryOpen(shouldOpenLoginEntry);
      return {
        hasUsableProvider,
        providerCount,
        shouldOpenLoginEntry,
      } satisfies ProviderAvailabilityLoginEntryGuardResult;
    },
    [
      enabled,
      modelSelectionView,
      providerFamilyDomain,
      refreshProviderState,
      readModelSelectionView,
      setLoginEntryOpen,
      user,
    ],
  );

  useEffect(() => {
    if (!enabled) {
      startupCheckCompletedRef.current = true;
      setStartupCheckCompleted(true);
      return;
    }

    if (modelSelectionError) {
      // 首次读取失败不能伪装成“没有 Provider”，也不能让启动门禁永久停在 loading。
      logger.error("[Root] provider 可用性读取失败，结束启动门禁等待", modelSelectionError);
      startupCheckCompletedRef.current = true;
      setStartupCheckCompleted(true);
      return;
    }

    if (
      startupCheckCompletedRef.current ||
      isRestoringOAuthSession ||
      !providerAvailabilityHydrated
    ) {
      return;
    }

    startupCheckCompletedRef.current = true;
    void syncLoginEntryWithProviderAvailability({
      reason: "startup",
    }).finally(() => {
      setStartupCheckCompleted(true);
    });
  }, [
    enabled,
    isRestoringOAuthSession,
    modelSelectionError,
    providerAvailabilityHydrated,
    syncLoginEntryWithProviderAvailability,
  ]);

  return {
    startupCheckCompleted,
    syncLoginEntryWithProviderAvailability,
  };
}
