/**
 * @zcode/acp-engine 公开入口：ACP 客户端引擎（见 docs/acp-bridge/DESIGN.md §4）。
 * 调用方只需要 createAcpEngine / loadAcpAgents 与 contract 类型；其余实现细节不导出。
 */
export * from "./contract.js";
export { createAcpEngine } from "./engine.js";
export {
  acpAgentsConfigPath,
  BUILTIN_CLAUDE_AGENT_ID,
  BUILTIN_CLAUDE_ENTRY_ENV,
  builtinClaudeAgent,
  loadAcpAgents,
  readAcpAgentsConfig,
  resolveBuiltinClaudeEntry,
  type AcpAgentsConfigReadResult,
  type BuiltinAgentProbe,
} from "./config.js";
