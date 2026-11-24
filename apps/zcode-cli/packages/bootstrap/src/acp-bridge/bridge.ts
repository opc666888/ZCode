/**
 * ACP 智能体 → ZCode 外部回合引擎（DESIGN §5）。
 *
 * - Provider：每个 agent 合成一个 `acp:<id>`，模型取 agent.models（缺省 ["default"]）。
 * - 回合：Core 对 `acp:` 选择调用 runTurn；这里把冻结选择映射回 agent 与 ACP modelId
 *   （`default` 表示不设置，用智能体自己的默认模型），其余事件/权限原样透传。
 */
import type { ModelSelection } from "@zcode/contracts";
import {
  ACP_DEFAULT_MODEL_ID,
  ACP_REASONING_LEVEL,
  acpAgentIdOf,
  buildAcpProviders,
  normalizeAcpSelection,
  withAcpProviders,
} from "./acp-providers.js";
import type {
  AcpBridge,
  AcpBridgeAgentConfig,
  CreateAcpBridgeOptions,
  ExternalTurnEngineAdapter,
} from "./contract.js";
import { createHostSessionResources, type HostSessionResources } from "./session-resources.js";

export function createAcpBridge(options: CreateAcpBridgeOptions): AcpBridge | undefined {
  const agents = options.agents.filter((agent) => agent.id.trim().length > 0);
  if (agents.length === 0) return undefined;
  const agentById = new Map<string, AcpBridgeAgentConfig>(agents.map((agent) => [agent.id, agent]));
  const providers = buildAcpProviders(agents);
  const agentOf = (selection: ModelSelection | undefined) => {
    const agentId = acpAgentIdOf(selection?.providerId);
    return agentId === undefined ? undefined : agentById.get(agentId);
  };
  let hostResources: HostSessionResources | undefined;
  const externalTurnEngine: ExternalTurnEngineAdapter = {
    handles: (selection) => agentOf(selection) !== undefined,
    runTurn: async (input, host) => {
      const agent = agentOf(input.selection);
      if (!agent) throw new Error(`ACP agent not configured: ${input.selection.providerId}`);
      const modelId = normalizeAcpSelection(input.selection, providers, agents).modelId;
      const level = (input.selection as { options?: { reasoningLevel?: unknown } }).options?.reasoningLevel;
      const effort = typeof level === "string" ? level : undefined;
      return options.engine.runTurn(
        {
          zcodeSessionId: input.sessionId,
          cwd: input.cwd,
          agent,
          ...(modelId && modelId !== ACP_DEFAULT_MODEL_ID ? { modelId } : {}),
          ...(effort && effort !== ACP_REASONING_LEVEL ? { effort } : {}),
          prompt: input.prompt,
          ...(input.images?.length ? { images: input.images } : {}),
          signal: input.signal,
          ...(hostResources ? { sessionResources: hostResources.forCwd(input.cwd) } : {}),
        },
        host,
      );
    },
  };
  return {
    agents,
    wrapProviderRegistry: (registry) => withAcpProviders(registry, providers, agents),
    externalTurnEngine,
    // 根因（W3 冒烟）：草稿默认选择 `acp:<id>/default` 不带 options，Registry 视图校验时补了档位，
    // 但 ApiProviderModelRuntime 直接读 target.selection.options.reasoningLevel → TypeError。
    wrapModelFactory: (factory) => (input) =>
      factory({ ...input, selection: normalizeAcpSelection(input.selection, providers, agents) }),
    setHostSessionResources: (input) => {
      try {
        hostResources = createHostSessionResources(
          { ...input, stateDir: options.stateDir ?? input.stateDir },
          options.log,
        );
      } catch (error) {
        // 插件能力交不过去不能拖垮会话：退回不带插件。
        options.log?.(`[acp-bridge] 插件能力装配失败：${(error as Error).message}`);
        hostResources = undefined;
      }
    },
  };
}
