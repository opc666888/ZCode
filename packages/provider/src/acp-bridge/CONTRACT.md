# provider-acp-bridge

把用户 `acp-agents.json` 里的 ACP 智能体合成为 Registry Provider `acp:<id>`（见 docs/acp-bridge/DESIGN.md §3、§5.1-4）。

- `buildAcpBridgeProviders(agents)`：纯函数；每个 agent 一个 Provider，模型取 `models`（去空、去重），缺省只有 `default`。
  字段必须与 CLI `apps/zcode-cli/packages/bootstrap/src/acp-bridge/acp-providers.ts` 的 `buildAcpProviders` 逐字段一致。
- `isAcpBridgeProviderId(providerId)`：UI/Host 识别 ACP 分组与准入的唯一判断，按 `acp:` 前缀。
- 不读文件、不接触 command/args/env；读取配置由调用方（Host 用 `@zcode/acp-engine` 的 `readAcpAgentsConfig`）负责。
- 合成的 Provider 不进入 Config/Settings，只经 `ProviderRegistryService` 的 `extraRegistryProviders` 进入 Registry。
