/**
 * cli-acp-bridge 模块清单（docs/acp-bridge/DESIGN.md §5）。
 * 层：adapters。修改 requires 时同步更新 architecture-policy.yaml。
 */
export const acpBridgeModule = {
  id: "cli-acp-bridge",
  provides: ["acp-bridge"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
