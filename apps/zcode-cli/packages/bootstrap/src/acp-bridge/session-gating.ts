/**
 * ACP 会话能力门控（DESIGN §1 非目标、§5.1-5）：fork / compact / 文件回退 / 目标模式
 * 在外部智能体会话里没有实现，投影直接下发 allowed:false，UI 按既有 availability 自动隐藏入口；
 * 同一 agent 内切模型（switchModelConfig）保留。行级 canFork/canEdit/canRetry/canRewindFiles 由调用方置 false。
 */
import type { SessionActionAvailability } from "@zcode/shared/zcode-protocol-v4";
import { ACP_PROVIDER_PREFIX } from "./acp-providers.js";

export const ACP_SESSION_UNSUPPORTED_REASON = "acpAgentSessionUnsupported";

export function isAcpProviderId(providerId: string | undefined | null): boolean {
  return typeof providerId === "string" && providerId.startsWith(ACP_PROVIDER_PREFIX);
}

export function restrictAcpSessionAvailability(
  availability: SessionActionAvailability,
): SessionActionAvailability {
  const denied = { allowed: false, reasonCode: ACP_SESSION_UNSUPPORTED_REASON } as const;
  return {
    ...availability,
    fork: denied,
    compact: denied,
    rewindFiles: denied,
    pauseGoal: denied,
    resumeGoal: denied,
  };
}
