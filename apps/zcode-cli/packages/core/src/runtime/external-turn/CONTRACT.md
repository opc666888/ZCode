# cli-external-turn

意图：让 ZCode 会话的一轮由外部智能体（ACP，见 docs/acp-bridge/DESIGN.md §5）执行，替代 runRegularTurnLoop；TurnStarted、排队、取消、TurnComplete 沿用上游 executeTurnCommand。

不变量：

- 只在 `AgentRuntimeDeps.externalTurnEngine.handles(本轮冻结选择)` 为 true 时生效；未注入或返回 false 时上游行为不变。
- 中性事件按到达顺序串行写入：事件日志与消息库同形于一个 model step（assistant message + step-start + 带 blockIndex 的 text/reasoning/tool part），冷恢复与 live 投影一致。
- 带 parentToolCallId 的事件写入对应子会话（`sess_subagent_agent_acp_*`，parentID=父会话）；父会话只收 SubagentSpawned/Message/Stopped。
- 权限请求只经 runtime 的 PermissionBroker，PermissionRequested/Resolved 写父会话；回合取消时返回 cancelled。
- 本模块不依赖任何 ACP 包，类型与 `@zcode/acp-engine` 结构一致。
