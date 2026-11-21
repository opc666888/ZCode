/**
 * acp-bridge: provider-acp-bridge 模块清单（docs/acp-bridge/DESIGN.md §5.1-4）。
 * 层：domain（纯函数合成 Provider，无 IO）。修改 requires 时同步更新 architecture-policy.yaml。
 */
export const providerAcpBridgeModule = {
  id: "provider-acp-bridge",
  provides: ["acp-bridge-providers"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
