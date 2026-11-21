/**
 * acp-bridge: ACP 智能体 Provider 的公开契约（docs/acp-bridge/DESIGN.md §3、§5.1-4）。
 *
 * Host（packages/services）与 UI 共用：Host 把 `acp-agents.json` 合成 Provider 注入 Registry，
 * UI 只按 providerId 前缀识别 ACP 分组。合成结果必须与 CLI
 * `apps/zcode-cli/packages/bootstrap/src/acp-bridge/acp-providers.ts` 逐字段一致。
 */
import type { Provider } from "../resolver.js";

/** Provider 合成只需要的 agent 字段；command/args/env 只属于 CLI 引擎，这里不接触。 */
export interface AcpBridgeProviderAgent {
  readonly id: string;
  readonly name: string;
  readonly models?: readonly string[];
}

export const ACP_BRIDGE_PROVIDER_PREFIX = "acp:";
export const ACP_BRIDGE_DEFAULT_MODEL_ID = "default";
/** 缺省档位：不设置思考强度，用智能体自己的默认值。 */
export const ACP_BRIDGE_REASONING_LEVEL = "default";
/** 思考强度档位（对应 Claude Code 的 effort）；与 CLI 的 ACP_REASONING_LEVELS 必须一致。 */
export const ACP_BRIDGE_REASONING_LEVELS = ["default", "low", "medium", "high", "xhigh", "max"] as const;

export type BuildAcpBridgeProviders = (agents: readonly AcpBridgeProviderAgent[]) => Provider[];
export type IsAcpBridgeProviderId = (providerId: string | null | undefined) => boolean;
