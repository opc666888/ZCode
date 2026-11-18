# ACP Bridge：让 ZCode 会话接入任意 ACP 智能体（设计）

> 分支：`feat/acp-agent-bridge`（基于上游 zai-org/ZCode v3.18.2，`fec97590`）。
> 许可：与上游相同，Apache-2.0。本分支的全部改动都在本仓库公开，可逐行审计。
> 目标读者：本项目实现者，以及想核查「这个分支到底改了什么」的用户。

## 1. 目标与非目标

**目标**
- 在 ZCode 里新增一类会话：由外部 **ACP（Agent Client Protocol）智能体** 驱动，比如官方 Claude Code 适配器 `claude-agent-acp`、`codex-acp` 等。
- 保留 ZCode 的使用体验：会话列表、子智能体面板、规划（todo）面板、工具调用卡片（文件 diff、终端）、权限确认弹窗、手机远控。
- 改动做成一个「挂点（hook）」：绝大部分代码放在一个新包里，上游文件只改很少几行，方便以后跟上游合并。

**非目标（第一版不做）**
- 不改 ZCode 自带 GLM 智能体的任何行为。用户不选 ACP 智能体时，体验和上游完全一样。
- 不做 ACP 会话的 fork、编辑重发、文件回退、目标模式、动态工作流、闲时任务。这些入口会对 ACP 会话自动隐藏（见 §6）。
- 不内置任何账号、令牌、代理配置。ACP 智能体怎么启动，完全由用户自己的配置文件决定（见 §3）。

## 2. 总体结构

```text
ZCode Desktop UI（不改或极少改）
   │  @zcode/protocol-v4（不改）
   ▼
ZCode Agent CLI（apps/zcode-cli）
   AgentRuntime.executeTurnCommand
      ├─ 普通会话 → runRegularTurnLoop（上游原逻辑）
      └─ ACP 会话 → ExternalTurnEngine.runTurn  ← 挂点（W2）
                       │
                       ▼
            packages/acp-engine（新包，W1）
              ACP 客户端（@agentclientprotocol/sdk 2.x）
              ACP update → 中性事件（EngineEvent）
                       │ stdio（JSON-RPC）
                       ▼
            外部 ACP 智能体进程（用户配置的 command/args/env）
              例：claude-agent-acp → Claude Code
```

为什么挂在 CLI、而不是另写一个替代 CLI 的进程：ZCode 的会话事实源、投影、排队、持久化、手机远控都在 CLI 里。挂在回合执行这一层，这些全部能直接复用。另写一个进程等于重写整套 v4 协议。

## 3. 用户配置：`acp-agents.json`

位置：`<ZCODE_DATA_BASE_DIR 或 ~>/.zcode/acp-agents.json`。格式与 Zed 的 `agent_servers` 对齐，方便直接迁移：

```json
{
  "agents": [
    {
      "id": "claude",
      "name": "Claude Code",
      "command": "/path/to/launcher-or-node",
      "args": ["/path/to/claude-agent-acp/dist/index.js"],
      "env": { "CLAUDE_CONFIG_DIR": "/Users/me/.claude" },
      "models": ["default", "opus", "sonnet"]
    }
  ]
}
```

- 每个 agent 在模型选择器里显示成一个分组，provider id 为 `acp:<id>`，模型 id 来自 `models`。没写 `models` 时只有一个 `default`。
- 切换模型：ACP `session/set_config_option`（id `model`）；`default` 表示不设置，用智能体自己的默认值。
- 多账号就配多个 agent，比如 `claude-work`、`claude-personal`，用 `env` 区分配置目录。
- 文件不存在或为空时，本功能完全不出现。

## 4. 新包 `apps/zcode-cli/packages/acp-engine`（W1）

只依赖 Node 标准库和 `@agentclientprotocol/sdk@2.4.0`，**不依赖 ZCode 内部包**，可以单独测试。

### 4.1 对外接口（契约，W1 实现，W2 调用）

```ts
// src/types.ts
export interface AcpAgentConfig { id: string; name: string; command: string; args?: string[]; env?: Record<string,string>; models?: string[] }

export type EngineEvent =
  | { kind: "text"; delta: string; parentToolCallId?: string }
  | { kind: "thought"; delta: string; parentToolCallId?: string }
  | { kind: "tool_start"; toolCallId: string; toolName: string; title: string; toolKind?: string;
      input: unknown; locations?: { path: string; line?: number }[]; parentToolCallId?: string }
  | { kind: "tool_update"; toolCallId: string; status?: "pending"|"in_progress"|"completed"|"failed";
      title?: string; input?: unknown; diffs?: { path: string; oldText: string | null; newText: string }[];
      text?: string; parentToolCallId?: string }
  | { kind: "plan"; entries: { content: string; status: "pending"|"in_progress"|"completed" }[] }
  | { kind: "usage"; inputTokens?: number; outputTokens?: number; cachedTokens?: number }
  | { kind: "mode"; modeId: string }
  | { kind: "commands"; commands: { name: string; description: string }[] }
  | { kind: "notice"; message: string };

export interface PermissionRequest {
  toolCallId: string; toolName: string; title: string; input: unknown;
  options: { optionId: string; name: string; kind: "allow_once"|"allow_always"|"reject_once"|"reject_always" }[];
}
export type PermissionDecision = { optionId: string } | { cancelled: true };

export interface TurnHost {
  emit(ev: EngineEvent): void | Promise<void>;
  requestPermission(req: PermissionRequest): Promise<PermissionDecision>;
}

export interface TurnInput {
  zcodeSessionId: string; cwd: string; agent: AcpAgentConfig; modelId?: string;
  prompt: string; images?: { mimeType: string; data: string }[]; signal: AbortSignal;
}
export interface TurnResult {
  stopReason: "end_turn"|"max_tokens"|"max_turn_requests"|"refusal"|"cancelled"|"error";
  error?: string; text: string; toolCallCount: number;
}

export interface AcpEngine {
  runTurn(input: TurnInput, host: TurnHost): Promise<TurnResult>;
  disposeSession(zcodeSessionId: string): Promise<void>;
  dispose(): Promise<void>;
}
export function createAcpEngine(opts: { stateDir: string; log?: (msg: string) => void }): AcpEngine;
export function loadAcpAgents(dataBaseDir: string): AcpAgentConfig[];
```

### 4.2 行为要求
- **进程**：每个 ZCode 会话一个 ACP 连接，首轮懒启动，`spawn(command, args, { env: {...process.env, ...agent.env}, cwd })`，走 stdio。进程退出就把该会话标记为需要重连，下一轮重新 `initialize` + `session/load`。
- **initialize**：`clientCapabilities` 声明 `fs.readTextFile/writeTextFile`（在 cwd 内实现），`terminal: false`（第一版），并在 `_meta` 里声明 `"subagent-transcript": true`，拿到子智能体的完整正文。
- **会话映射**：`<stateDir>/sessions.json` 存 `zcodeSessionId → { agentId, acpSessionId }`，原子写。已有映射且智能体支持 `loadSession` 时用 `session/load`，否则 `session/new`。
- **update 映射**：
  - `agent_message_chunk` / `agent_thought_chunk` 映射为 `text` / `thought`；
  - `tool_call` 映射为 `tool_start`。`toolName` 优先取 `_meta.claudeCode.toolName`，其次取 `title`；
  - `tool_call_update` 映射为 `tool_update`。content 里的 `diff` 放进 `diffs`，`content` 和 `terminal` 的文本拼成 `text`；
  - `plan` 映射为 `plan`，`usage_update` 映射为 `usage`，`current_mode_update` 映射为 `mode`，`available_commands_update` 映射为 `commands`；
  - 其他未知类型忽略，只写日志；
  - 所有事件透传 `_meta.claudeCode.parentToolUseId`，作为 `parentToolCallId`。
- **权限**：`session/request_permission` 转给 `host.requestPermission`。用户决定后按 optionId 回给智能体；回合被取消时回 `cancelled`。
- **取消**：`signal` 触发时发 `session/cancel`，等智能体回 `stopReason: cancelled`。最多等 5 秒，超时就杀进程。
- **安全**：不读、不写、不记录任何令牌；日志里不打印 `env` 的值。

### 4.3 测试（W1 必须交付）
- `test/fake-agent.mjs`：用 SDK 的 `AgentSideConnection` 写一个假智能体，按脚本发出文本、思考、工具调用（含 diff）、plan、权限请求、子智能体（带 parentToolUseId）、usage，并支持取消。
- 单元测试覆盖 update 映射的每个分支；集成测试用 fake agent 跑完整一轮、取消一轮、拒绝权限一轮、进程崩溃后 `session/load` 重连。
- 不调用真实 Claude（不消耗额度）。

## 5. 运行时挂点（W2）

### 5.1 上游文件改动（尽量少）
1. `core/src/runtime/types.ts`：`AgentRuntimeDeps` 加可选字段 `externalTurnEngine?: ExternalTurnEngineAdapter`。
2. `core/src/runtime/methods/turn.ts`：
   - 约 :290，当前选择是 ACP provider 时跳过 `createTurnModel`；
   - 约 :912，ACP 会话时调 `externalTurnEngine.runTurn(...)`，不调 `runRegularTurnLoop`。TurnStarted、TurnComplete、排队、中止都沿用原逻辑。
3. `bootstrap/src/app/create-app.ts`：构造 `AgentRuntime` 时注入适配器。
4. Provider 注册：把 `acp-agents.json` 里的智能体合成为 Provider 条目，注入 `ProviderRegistry`，保证模型选择器能看到、准入校验能通过。需要时给 `api.type` 加一个值 `acp`，并确认 UI 的分组过滤不会把它挡掉。
5. 会话可用性：ACP 会话在快照里下发 `availability.{fork, compact, rewindFiles, pauseGoal, resumeGoal}` 为 `allowed:false`，`switchModelConfig` 仍允许（同一 agent 内切模型）；行级 `canFork/canEdit/canRetry/canRewindFiles` 一律为 false；斜杠命令改用 ACP 下发的 `commands`。
6. Stop：`stopActiveForegroundExecution` 触发同一个 `turnAbortSignal`，引擎据此发 `session/cancel`。

### 5.2 适配器（W2 新文件，放在 core 或 bootstrap 内的独立目录，如 `bootstrap/src/acp-bridge/`）
把 `EngineEvent` 翻译成 ZCode 的会话事件，并写入消息库：
- `text` / `thought` 发 `ModelStreaming`（`text_delta` / `reasoning_delta`），回合结束时用 `persistAssistantMessage` / `persistPart` 落库。必须满足投影对 `assistantMessageId` / `partId` 配对的要求，参考 `runRegularTurnLoop` 的发事件顺序。
- `tool_start` / `tool_update` 发 `ToolCallScheduled → Started → Progress → Result/Error`，`toolName` 用 Claude Code 的原名（UI 的工具家族表本来就认这些名字）。diff 转成 `display: file_diff`，生成 structuredPatch。工具 part 用 `persistPendingToolPart` 等方法落库。
- `plan`：合成一条 TodoWrite 工具调用（input 为 `{todos:[{content,status,activeForm}]}`），复用投影现有的 plan 解析。
- 子智能体：`toolName` 为 `Agent` 或 `Task` 的 `tool_start` 先发 `SubagentSpawned`，同时**创建一个子会话**（`childSessionId`），`parentToolCallId` 指向该工具调用。之后带同一 `parentToolCallId` 的事件写进子会话的事件日志和消息库，不写父会话，这样 UI 的子智能体下钻（订阅 `conversation/<childSessionId>`）能看到完整过程。对应工具调用完成时发 `SubagentStopped`，并把最后的文本作为摘要发 `SubagentMessage`。
- 权限：`requestPermission` 转 `PermissionBrokerPort` / interaction registry，生成 `PermissionRequested`；用户的 allowOnce / allowAlways / deny 映射回 ACP optionId。
- 用量：`usage` 汇总进 `TurnComplete.usage`。

## 6. 本地开发与验证（W3）

- **数据隔离（硬性要求）**：本机正装的 ZCode 是 owner 的主力工具，开发版**不能**碰它的数据。开发和测试一律设 `ZCODE_DATA_BASE_DIR=<项目工作区>/workspace-runtime/tmp/20261119-zcode-acp/data`，Electron 的 userData 也要隔离（参考 `packages/desktop/src/main/desktopRuntimeEnv.ts` 里 e2e 的隔离做法）。不改全机共享的东西（launchd、全局端口、钥匙串）。
- 提供 `scripts/acp-dev/`：一键构建 CLI，并以隔离数据目录启动桌面开发版；再给一个无界面的冒烟脚本，直接对 CLI 的 app-server stdio 发 v4 命令，用 fake agent 跑一轮并断言快照（rows、plan、subagents、availability）。
- 真机验收：用 owner 现有的 Claude 启动器（不入仓，只在本机 `acp-agents.json` 里引用）跑 3 个场景：普通问答；改一个文件（看 diff 卡片和权限弹窗）；派一个子智能体（看子智能体面板和下钻）。每个场景都截图。

## 7. 分工与文件所有权（并行开发防冲突）

| 路 | 负责 | 只能写这些路径 |
|---|---|---|
| W1 | ACP 引擎包 | `apps/zcode-cli/packages/acp-engine/**`，以及根 `pnpm-workspace.yaml` / lockfile 中新增该包所需的部分 |
| W2 | 运行时挂点、适配器、Provider 注册、可用性门控 | §5.1 列出的上游文件，以及 `apps/zcode-cli/packages/bootstrap/src/acp-bridge/**`（或 W2 选定的同类独立目录，须在提交说明写明） |
| W3 | 开发脚本、隔离启动、冒烟测试、README | `scripts/acp-dev/**`、`docs/acp-bridge/**`（DESIGN.md 只由主控改） |

W2 依赖 W1 的接口。W1 先提交 `src/types.ts`（§4.1 原样），W2 按接口开发，联调前可以先用 stub 顶上。

## 8. 验收合同（主控亲验）

1. `pnpm --filter` 下 acp-engine 的单测和集成测试全部通过（fake agent）。
2. 上游已有的 CLI 测试不出现新的失败：改动前后各跑一次受影响包的测试，对比失败列表。
3. 冒烟：fake agent 一轮跑下来，快照里有文本行、工具行（含 diff）、plan 条目、子智能体行（含 childSessionId，且子会话可订阅）；ACP 会话的 availability 是 `allowed:false`；stop 能中止。
4. 真机：§6 的 3 个场景截图，主控亲自看图。
5. `git diff upstream/main --stat`：上游文件改动集中在 §5.1 的范围内。
6. 不提交任何账号、令牌、本机路径、代理配置。
