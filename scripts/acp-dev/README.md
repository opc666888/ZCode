# ACP Bridge 本地开发工具（scripts/acp-dev）

给 `feat/acp-agent-bridge` 分支用的三件事：**构建 Agent CLI**、**隔离启动桌面开发版**、**无界面冒烟**。
设计背景见 [`docs/acp-bridge/DESIGN.md`](../../docs/acp-bridge/DESIGN.md) §6 / §8。

> 本机如果同时装着正式版 ZCode，这些脚本保证开发版**不碰**它：不共用 app name / userData / 单实例锁，
> 不写 `~/.zcode`，不抢 `zcode://` 协议，不碰钥匙串、launchd、9229/5174 端口。原理见下面「隔离做了什么」。

所有命令都在仓库根目录执行，需要 Node 24（脚本会自动 `nvm use 24`）。

## 1. 构建 Agent CLI

```bash
bash scripts/acp-dev/build-cli.sh          # 完整构建（仓库自带的 scripts/build-desktop-agent-cli.mjs）
bash scripts/acp-dev/build-cli.sh --quick  # 只重建 acp-engine/core/adapters/bootstrap/cli，改完 CLI 代码后快速迭代
```

- 产物：`apps/zcode-cli/packages/cli/dist/zcode.cjs`，并暂存到 `packages/desktop/bundled-agents/<平台>/glm/zcode.cjs`（桌面开发版从这里拉起 CLI）。
- `acp-engine` 包有 `build` 脚本时会先构建它。
- 日志：`<隔离根>/logs/build-cli-*.log`，末尾记录耗时 `BUILD_CLI_SECONDS`。

## 2. 隔离启动桌面开发版

```bash
bash scripts/acp-dev/run-desktop-isolated.sh build    # 首次或改了桌面/UI 代码后：构建桌面（tsup + vite build）
bash scripts/acp-dev/run-desktop-isolated.sh start    # 后台启动，打印隔离核验结果
bash scripts/acp-dev/run-desktop-isolated.sh shot 01-main   # 只截开发版窗口 → docs/acp-bridge/screenshots/01-main.png
bash scripts/acp-dev/run-desktop-isolated.sh status
bash scripts/acp-dev/run-desktop-isolated.sh stop     # 关闭
```

启动日志 `<隔离根>/logs/desktop-latest.log` 里能看到护栏打印的**实际路径**与「隔离核验通过」；
任何一项不在隔离根下，护栏会让应用立即退出（宁可起不来，也不碰正式版数据）。

Dock 里显示的是原版 Electron 图标，窗口标题/菜单名是 `ZCode ACP Dev`，和正式版很好区分。

首次启动会出现区域选择/登录页：**不要用自己的正式账号登录**。ACP 会话不需要登录 ZCode 账号。

## 3. 无界面冒烟

```bash
node scripts/acp-dev/smoke.mjs             # 跑到能跑的最远阶段，未就绪阶段记 PENDING
node scripts/acp-dev/smoke.mjs --strict    # PENDING 也算失败（集成完成后验收用）
node scripts/acp-dev/smoke.mjs --deny      # 权限请求一律拒绝
node scripts/acp-dev/smoke.mjs --verbose   # 打印 CLI stderr 与入站消息
node scripts/acp-dev/smoke.mjs --dump      # 关键快照（草稿、ACP 回合结束）完整写到 <隔离根>/logs/smoke-dump-<时间>/
```

直接以子进程拉起 `zcode.cjs app-server --stdio`，按 ZCode 协议（NDJSON + `v4/*`）驱动，不经过桌面：

| 阶段 | 做什么 | 判定 |
|---|---|---|
| 1 handshake | `runtime/capabilities` | 有返回 |
| 2 draft | `v4/command createSession`（无首条消息）+ 订阅 `conversation/<id>` | 拿到 snapshot，phase=draft |
| 3 providers | 订阅 `workspace-config/<workspaceKey>`；并看第 2 阶段草稿的默认模型选择 | workspace-config 模型选项里有 `acp:fake`，**或**草稿默认选择落到 `acp:fake`（见下方说明） |
| 4 acp-turn | `createSession(firstInput, modelSelection=acp:fake/default)`，轮询快照到回合结束，权限弹窗自动 allowOnce | DESIGN §8.3：文本行、工具行含 `file_diff`、plan、带 `childSessionId` 的子智能体行；`fork/compact/rewindFiles/pauseGoal/resumeGoal` 为 `allowed:false`，`switchModelConfig` 允许 |
| 5 child-subscribe | 订阅 `conversation/<childSessionId>` | 子会话有行 |
| 6 stop | 同会话再发一条慢回合（`ACP_SMOKE_SLOW_PROMPT`），running 后发 `stop` | phase=`completedInterrupted` |

关于第 3 阶段：CLI 的 `workspace-config` 不下发模型清单——桌面模型选择器读的是 **Host 进程自己的** ProviderRuntime
（`packages/services/src/node.ts` 里注册的 `IModelSelectionService`），不是 CLI 里的 Registry。所以无界面冒烟只能证明
「CLI Registry 认得 `acp:fake` 且通过准入」（未登录时内置 provider 全不可用，新草稿的默认选择就会落到它）；
模型选择器里能不能看到 ACP 分组，要用下面的 GUI 验证看。

第 4 阶段失败时，冒烟会把本次运行期间 CLI 结构化日志（`<隔离根>/home/.zcode/cli/log/*.jsonl`）里的 `error` 级事件
摘几条打出来（例如 `turn.failed model_creation ← <原因>`）——快照里通常只看得到 phase，原因在日志里。

冒烟会在 `<隔离根>/data/.zcode/acp-agents.json` 写一份配置，`fake` 指向
`apps/zcode-cli/packages/acp-engine/test/fake-agent.mjs`（W1 交付）。可用环境变量覆盖：
`ACP_SMOKE_PROMPT`、`ACP_SMOKE_SLOW_PROMPT`、`ACP_SMOKE_AGENT_CMD`、`ACP_SMOKE_AGENT_ARGS_JSON`。

CLI 的 stderr 落在 `<隔离根>/logs/smoke-cli-stderr-*.log`；CLI 自己的会话库/日志在 `<隔离根>/home/.zcode/cli/`。

## 4. 用自己的 Claude 启动器做真机验收

在**隔离根**（不是 `~`）下写 `data/.zcode/acp-agents.json`。示例只写占位路径，真实路径只留在本机，不要提交：

```json
{
  "agents": [
    {
      "id": "claude",
      "name": "Claude Code",
      "command": "/path/to/your/claude-acp-launcher",
      "args": [],
      "env": { "CLAUDE_CONFIG_DIR": "/path/to/your/claude-config-dir" },
      "models": ["default", "opus", "sonnet"]
    }
  ]
}
```

注意：

- 开发版的 `HOME` 被改成了 `<隔离根>/home`。依赖 `HOME` 找配置的启动器（比如没显式传 `CLAUDE_CONFIG_DIR` 时会去读 `~/.claude`），请在 `env` 里把它需要的路径写成**绝对路径**，必要时显式加 `"HOME": "/Users/you"`——这只影响这个智能体子进程，不影响开发版本身的隔离。
- 多账号就配多个 agent（`claude-work`、`claude-personal`），各自用 `env` 指不同的配置目录。
- 改完配置后 `stop` 再 `start` 开发版。

## 隔离做了什么

| 共享资源 | 正式版用的 | 开发版用的 |
|---|---|---|
| app name / 单实例锁 | `ZCode` | `ZCode ACP Dev`（`ZCODE_DESKTOP_APPLICATION_NAME`） |
| Electron userData | `~/Library/Application Support/ZCode` | `<隔离根>/electron-userdata`（`ZCODE_DESKTOP_USER_DATA_DIR`） |
| Host 数据 `~/.zcode/v2` | `~/.zcode` | `<隔离根>/data/.zcode`（`ZCODE_DATA_BASE_DIR`） |
| CLI 数据 `~/.zcode/cli`（会话库/日志/插件，按 `HOME` 解析） | `~/.zcode/cli` | `<隔离根>/home/.zcode/cli`（`HOME`） |
| 临时文件 | 系统 TMPDIR | `~/.zacp-tmp` → `<隔离根>/tmpdir`（短软链，避开 104 字节 socket 路径上限） |
| `zcode://` 默认协议处理器 | 正式版 | 护栏拦截 `app.setAsDefaultProtocolClient`，不改 LaunchServices |
| 登录钥匙串 | 系统钥匙串 | `--use-mock-keychain` |
| 端口 | — | 不开 9229 远程调试（`ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT=1`），不起 vite dev（5174） |
| launchd / 登录项 | — | 不碰（`nohup` 起进程，护栏拦截 `setLoginItemSettings`） |

`<隔离根>` 默认是 `<项目工作区>/workspace-runtime/tmp/20261119-zcode-acp`，可用 `ACP_DEV_ROOT` 覆盖（不允许是 `$HOME` 或 `/tmp`）。
短软链位置可用 `ACP_DEV_SHORT_TMP` 覆盖。

## 清理

```bash
bash scripts/acp-dev/run-desktop-isolated.sh stop
rm -rf <隔离根>         # 全部隔离数据
rm ~/.zacp-tmp           # 短软链
```
