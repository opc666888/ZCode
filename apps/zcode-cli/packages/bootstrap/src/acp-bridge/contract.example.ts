import type { CreateAcpBridgeOptions } from "./contract.js";
import { createAcpBridge } from "./bridge.js";

/** 一个 agent、两个模型：模型选择器出现 `acp:claude/default`、`acp:claude/opus`。 */
export function createAcpBridgeExample(engine: CreateAcpBridgeOptions["engine"]) {
  return createAcpBridge({
    agents: [{ id: "claude", name: "Claude Code", command: "claude-agent-acp", models: ["default", "opus"] }],
    engine,
  });
}
