/**
 * acp-engine 标准调用示例：跑一轮 ACP 回合，把事件交给宿主，权限请求交给宿主决定。
 */
import type { AcpAgentConfig, AcpEngineContract, TurnResult } from "./contract.js";

export async function exampleAcpEngine(
  engine: AcpEngineContract,
  agent: AcpAgentConfig,
  signal: AbortSignal,
): Promise<TurnResult> {
  return engine.runTurn(
    { zcodeSessionId: "session-1", cwd: "/path/to/workspace", agent, prompt: "hello", signal },
    {
      emit: (ev) => void ev,
      requestPermission: async (req) => ({ optionId: req.options[0]?.optionId ?? "reject" }),
    },
  );
}
