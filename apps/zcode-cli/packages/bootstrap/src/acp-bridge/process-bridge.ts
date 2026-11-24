/**
 * 进程级装配：读 `<ZCODE_DATA_BASE_DIR 或 ~>/.zcode/acp-agents.json`，有 agent 才创建引擎。
 *
 * 引擎在进程内只建一个（同一 stateDir），所有会话共享：acp-engine 按 zcodeSessionId 各自
 * 维护 ACP 连接，并独占写 `<stateDir>/sessions.json`，多实例会互相覆盖映射。
 * agents 每次建 app 时重读（同步、只读），新增 agent 对新会话立即生效。
 */
import { join } from "node:path";
import { resolveZCodeDataBaseDir } from "@zcode/adapters/config";
import { createAcpEngine, readAcpAgentsConfig } from "@zcode/acp-engine";
import type { Logger } from "@zcode/contracts";
import { createAcpBridge } from "./bridge.js";
import type { AcpBridge, AcpBridgeEngine } from "./contract.js";

let processEngine: { stateDir: string; engine: AcpBridgeEngine } | undefined;

export function loadProcessAcpBridge(
  env: Readonly<Record<string, string | undefined>>,
  logger?: Logger,
): AcpBridge | undefined {
  const dataBaseDir = resolveZCodeDataBaseDir({ ...env });
  let agents: ReturnType<typeof readAcpAgentsConfig>["agents"];
  try {
    const config = readAcpAgentsConfig(dataBaseDir);
    agents = config.agents;
    // 坏条目已被跳过；errors 只含字段名与序号，不含 env 值，可直接记日志给用户排查。
    if (config.errors.length > 0) {
      logger?.warn("ACP agents config has invalid entries", {
        event: "acp_bridge.config.invalid_entries",
        module: "bootstrap.acp_bridge",
        errors: config.errors,
      });
    }
  } catch (error) {
    // 配置坏了只关闭本功能，不能拖垮普通会话启动。
    logger?.warn("ACP agents config could not be loaded", {
      event: "acp_bridge.config.load_failed",
      module: "bootstrap.acp_bridge",
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
  if (agents.length === 0) return undefined;
  const stateDir = join(dataBaseDir, ".zcode", "acp-bridge");
  if (processEngine?.stateDir !== stateDir) {
    processEngine = {
      stateDir,
      engine: createAcpEngine({
        stateDir,
        log: (message) =>
          logger?.info("ACP engine", { event: "acp_bridge.engine", module: "bootstrap.acp_bridge", message }),
      }),
    };
  }
  logger?.info("ACP agents loaded", {
    event: "acp_bridge.config.loaded",
    module: "bootstrap.acp_bridge",
    agentIds: agents.map((agent) => agent.id),
  });
  return createAcpBridge({
    agents,
    engine: processEngine.engine,
    stateDir,
    log: (message) => logger?.info("ACP bridge", { event: "acp_bridge.resources", module: "bootstrap.acp_bridge", message }),
  });
}
