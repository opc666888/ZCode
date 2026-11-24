/**
 * acp-bridge 装配契约（docs/acp-bridge/DESIGN.md §5）。
 *
 * 引擎侧类型与 `@zcode/acp-engine` 的 AcpEngine / AcpAgentConfig 结构一致；这里用结构类型声明，
 * 测试可直接注入 stub 引擎，不依赖真实 ACP 进程。
 */
import type { AcpSessionResources } from "@zcode/acp-engine";
import type { HostSessionResourcesInput } from "./session-resources.js";
import type { AgentRuntimeDeps } from "@zcode/core";
import type { ProviderRegistryModelSource } from "../app/provider-registry-model-runtime.js";

export type ExternalTurnEngineAdapter = NonNullable<AgentRuntimeDeps["externalTurnEngine"]>;
export type RuntimeModelFactory = AgentRuntimeDeps["modelFactory"];
type ExternalTurnHost = Parameters<ExternalTurnEngineAdapter["runTurn"]>[1];
export type AcpBridgeEngineEvent = Parameters<ExternalTurnHost["emit"]>[0];

export interface AcpBridgeAgentConfig {
  id: string;
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  models?: string[];
}

export interface AcpBridgeTurnInput {
  zcodeSessionId: string;
  cwd: string;
  agent: AcpBridgeAgentConfig;
  modelId?: string;
  prompt: string;
  images?: { mimeType: string; data: string }[];
  signal: AbortSignal;
  /** 交给智能体的插件 MCP 与技能（见 session-resources.ts）。 */
  sessionResources?: AcpSessionResources;
}

/** 与 acp-engine TurnHost 同形：emit 中性事件，requestPermission 等用户作答。 */
export interface AcpBridgeTurnHost {
  emit(event: AcpBridgeEngineEvent): void | Promise<void>;
  requestPermission: ExternalTurnHost["requestPermission"];
}

export interface AcpBridgeEngine {
  runTurn(
    input: AcpBridgeTurnInput,
    host: AcpBridgeTurnHost,
  ): ReturnType<ExternalTurnEngineAdapter["runTurn"]>;
  disposeSession(zcodeSessionId: string): Promise<void>;
  dispose(): Promise<void>;
}

/** 一次装配的结果；没有可用 agent 时 bridge 为 undefined，create-app 不做任何改动。 */
export interface AcpBridge {
  readonly agents: readonly AcpBridgeAgentConfig[];
  /** 合成 `acp:<id>` Provider 后的 Registry 视图：准入校验与 Model 工厂都经它。 */
  wrapProviderRegistry(registry: ProviderRegistryModelSource): ProviderRegistryModelSource;
  readonly externalTurnEngine: ExternalTurnEngineAdapter;
  /**
   * ACP 选择缺思考档位时补齐唯一取值再交给原 Factory；其他选择原样透传。
   * 草稿默认选择、子会话与旧会话恢复都可能不带 options.reasoningLevel。
   */
  wrapModelFactory(factory: RuntimeModelFactory): RuntimeModelFactory;
  /** create-app 解析完插件与 MCP 后调用：之后新建的 ACP 会话会带上这些插件能力。 */
  setHostSessionResources(input: HostSessionResourcesInput): void;
}

export interface CreateAcpBridgeOptions {
  agents: readonly AcpBridgeAgentConfig[];
  engine: AcpBridgeEngine;
  /** acp-bridge 状态目录（生成 Claude 插件外壳用）。 */
  stateDir?: string;
  log?: (message: string) => void;
}
