# cli-acp-bridge

意图：把 `acp-agents.json` 里的外部 ACP 智能体接进 ZCode 会话（docs/acp-bridge/DESIGN.md §3、§5）：合成 `acp:<id>` Provider 叠加到进程 Registry，并把这些选择的回合交给 `@zcode/acp-engine` 执行（经 Core 的 `externalTurnEngine` 挂点）。

不变量：

- 配置文件不存在、为空或无法解析时返回 undefined，create-app 不做任何改动（普通会话零影响）。
- 合成 Provider 的 Model 永不发请求：api.baseUrl 指向本地不可达占位地址，回合一律由外部引擎执行。
- 进程内只有一个 AcpEngine（同一 stateDir），按 zcodeSessionId 区分会话；不读写、不记录任何令牌或 env 值。
- `default` 模型表示不设置 ACP 模型，用智能体自己的默认值。
