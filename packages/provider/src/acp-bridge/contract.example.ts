// acp-bridge: 用法示例——Host 把 acp-agents.json 读到的 agent 合成 Provider，注入 Registry。
import { buildAcpBridgeProviders, isAcpBridgeProviderId } from "./index.js";

export function exampleAcpBridgeProviderIds(): string[] {
  return buildAcpBridgeProviders([{ id: "claude", name: "Claude Code", models: ["sonnet"] }])
    .map((provider) => provider.providerId)
    .filter((providerId) => isAcpBridgeProviderId(providerId));
}
