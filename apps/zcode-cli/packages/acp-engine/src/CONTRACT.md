# acp-engine

意图：让 ZCode 会话由外部 ACP（Agent Client Protocol）智能体驱动。本模块只负责「ACP 客户端 + 把 ACP 的 session/update 翻译成中性事件 EngineEvent」，不依赖任何 ZCode 内部包；把中性事件翻译成 ZCode 会话事件的工作在运行时适配器（hook 点：AgentRuntime 回合执行，见 docs/acp-bridge/DESIGN.md §5）。

不变量：

- 不读、不写、不记录任何账号令牌；日志不打印 agent.env 的值。
- 每个 ZCode 会话最多一个 ACP 连接；zcodeSessionId → acpSessionId 映射原子写入 stateDir/sessions.json。
- runTurn 在 signal 中止后 5 秒内必定返回（先 session/cancel，超时杀进程），stopReason 为 cancelled。
- 所有带 _meta.claudeCode.parentToolUseId 的 update 都把它透传为 parentToolCallId。
