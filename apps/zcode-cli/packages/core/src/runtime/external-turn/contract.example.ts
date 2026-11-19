import type { ExternalTurnEngineAdapter } from "./contract.js";

/** 最小引擎：只接管 `acp:` 前缀的选择，回一段文字后结束本轮。 */
export const echoExternalTurnEngineExample: ExternalTurnEngineAdapter = {
  handles: (selection) => selection?.providerId.startsWith("acp:") === true,
  async runTurn(input, host) {
    await host.emit({ kind: "text", delta: `echo: ${input.prompt}` });
    return { stopReason: "end_turn", text: `echo: ${input.prompt}`, toolCallCount: 0 };
  },
};
