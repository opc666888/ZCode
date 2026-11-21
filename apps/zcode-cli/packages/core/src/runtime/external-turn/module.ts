/**
 * cli-external-turn 模块清单（acp-bridge，docs/acp-bridge/DESIGN.md §5）。
 * 层：app。修改 requires 时同步更新 architecture-policy.yaml。
 */
export const externalTurnModule = {
  id: "cli-external-turn",
  provides: ["external-turn"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
