# 隐私模式（acp-bridge 分支）

目标：除了**用户自己选的 AI 服务**和**用户主动点的功能**，客户端不主动连智谱（z.ai / bigmodel.cn / zcode.z.ai / cdn-zcode.z.ai）服务器，也不发送设备 ID（`X-Device-Mid`）。

本文是对外宣传的如实清单：哪些已经改了、仍会连哪些服务器、什么时候连、哪些还没做完。依据为出网审计 `.task/research-W4-egress.md`（v3.18.2）。

> **2026-11-22 起 Claude 360 Code 安装包默认关闭隐私模式**（owner：「你把它关掉，它怎么用啊」）：插件市场、自动化模板、远程配置等照上游正常连智谱。构建时设 `ZCODE_PRIVACY_MODE=0`，桌面端启动时也把未设置的 `ZCODE_PRIVACY_MODE` 置为 `0`；遥测、事件上报、自动更新仍不打进安装包（没有私有构建配置）。下表「待处理」不再推进；需要时用户自己设 `ZCODE_PRIVACY_MODE=1` 打开。

## 开关

| 场景                                               | 行为                                            |
| -------------------------------------------------- | ----------------------------------------------- |
| 默认                                               | **开启**                                        |
| 构建时 `ZCODE_PRIVACY_MODE=0`（或 `false/off/no`） | 构建出与上游一致的行为（Renderer 只看构建期值） |
| 运行时 `ZCODE_PRIVACY_MODE=0`                      | Main/Host/Server 等 Node 进程恢复上游行为       |
| 运行时 `ZCODE_PRIVACY_MODE=1`                      | 在关闭隐私模式的构建上重新开启（Node 进程）     |

- 判定入口唯一：`@zcode/shared/privacy-mode` 的 `isPrivacyMode()`（优先级：运行时环境变量 > 构建期 `__ZCODE_PRIVACY_MODE__` > 开启）。
- 每个调用点一行守卫，统一注释 `// acp-bridge(privacy):`，`grep -rn "acp-bridge(privacy)"` 可列出全部改动点。
- 回归取样：`pnpm --filter @zcode/desktop test:privacy-mode`、`node --test scripts/test/build-time-config.test.mjs`。

## 已改（审计 1–7）

| #   | 内容                                                                 | 改动位置                                                                                                                                                                  | 隐私模式下的行为                                                                                                                                       | 状态                                                                                                                           |
| --- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| 1   | 营销弹窗轮询                                                         | `packages/ui/src/components/marketing-touch/MarketingTouchProvider.tsx`、`packages/services/src/marketing-touch/marketingTouchService.ts`                                 | UI 不创建营销 runtime（不轮询、不弹窗、无 Banner）；服务层兜底返回空投放、不上报                                                                       | 完成                                                                                                                           |
| 2a  | 远程灰度配置 `client/configs`（桌面上下文提示、渲染埋点灰度）        | `packages/desktop/src/main/desktopContextPromptRollout.ts`                                                                                                                | 不请求，按「服务端未下发」处理，各灰度项关闭                                                                                                           | 完成                                                                                                                           |
| 2b  | 帮助/社区/反馈链接配置                                               | `packages/desktop/src/main/desktopHelpConfig.ts`                                                                                                                          | 不请求，用安装包内 `config/default.json`                                                                                                               | 完成                                                                                                                           |
| 2c  | 公共客户端配置（插件商店排序、UI 插件推荐、漏洞上报链接）            | `packages/services/src/client-config/clientConfigService.ts`                                                                                                              | 不请求，返回空配置                                                                                                                                     | 完成                                                                                                                           |
| 2d  | 平台灰度（动态工作流、Off-Peak、套餐静态目录等，Agent 运行时也会读） | `packages/services/src/coding-plan-subscription/bigmodelCodingPlanSubscriptionProvider.ts`                                                                                | **未登录 z.ai** 时不匿名请求，走本地默认；登录后照常请求                                                                                               | 完成                                                                                                                           |
| 2e  | 远程场景配置 `client/scenes`（草稿页推荐提示词、自动化模板）         | `packages/services/src/client-scenes/clientScenesService.ts`                                                                                                              | 不请求，列表为空                                                                                                                                       | 完成                                                                                                                           |
| 2f  | 内置供应商列表远程下发                                               | `packages/provider-node/src/zcode-builtin-download.ts`、`packages/services/src/model-provider/zcodeBuiltinRemoteConfig.ts`、CLI `process-provider-registry-runtime.ts:73` | —                                                                                                                                                      | **未完成**（不在本路改动范围，见下文「待处理」）                                                                               |
| 3   | 启动强制更新检查                                                     | `packages/desktop/src/main/index.ts`                                                                                                                                      | 仅在「正式版 + 打包 + 自动更新开启 + 非隐私模式」时检查；开源构建不联网查最低版本                                                                      | 完成                                                                                                                           |
| 4   | 构建期上报/更新能力                                                  | `scripts/build-time-config.mjs`、`packages/desktop/tsup.config.ts`                                                                                                        | ARMS、事件上报、自动更新显式置空；Agent OTLP 不注入（发布构建也不要求）；存在 `config/private/build-defaults.json` 或注入了上报/更新变量时构建直接失败 | 完成                                                                                                                           |
| 4'  | 事件上报运行时兜底                                                   | `packages/services/src/telemetry/telemetryCore.ts`                                                                                                                        | 即使构建带了端点，隐私模式下也不发                                                                                                                     | 完成                                                                                                                           |
| 5   | 设备 ID 头 `X-Device-Mid`                                            | `packages/services/src/providers/sourceHeaders.ts`、`providers/api/nodeApiClient.ts`、`session/offPeakServerClient.ts`                                                    | 只在请求本身带 z.ai 登录凭据（Authorization）时发送；匿名请求不带                                                                                      | App 侧完成；CLI 侧见「待处理」                                                                                                 |
| 6   | 搜图（image-search）、建站（zcode-site）插件默认关                   | 默认启用集合由 CLI `official-plugin-definitions.ts` 决定                                                                                                                  | —                                                                                                                                                      | **未完成**（CLI 侧，见下文）                                                                                                   |
| 7   | 官方插件市场目录不在启动/默认时拉取                                  | `packages/ui/src/settings/PluginStorePage.tsx`                                                                                                                            | 进入插件商店不再自动刷新 CDN 目录，用户点「刷新」才拉                                                                                                  | 完成（启动时本来就不拉）                                                                                                       |
| 8   | 插件图标 CDN 不预加载                                                | `packages/ui/src/v4/ConversationDraftSuggestedPrompts.tsx`                                                                                                                | 草稿页推荐项的远程图标改用本地图标                                                                                                                     | **部分完成**：设置页/商店里的官方插件图标仍来自 cdn-zcode（图标地址由 CLI 插件定义和商店目录给出），只在用户打开这些页面时加载 |

## 仍会连智谱服务器的情况（如实清单）

全部是用户主动触发，或用户选择了智谱的服务：

| 什么时候                               | 连哪里                                                                                                          | 是否带设备 ID        |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------- |
| 用户选用智谱模型（GLM / Coding Plan）  | 用户所选服务的 API；登录后的额度、套餐、Off-Peak、平台配置（`zcode.z.ai /api/v1/client/configs` 等）            | 带（已登录）         |
| 用户登录 z.ai / bigmodel.cn            | `chat.z.ai` 或 `bigmodel.cn` 授权页，换取令牌与资料走 `zcode.z.ai /api/v1/oauth/*`                              | 带（登录后的请求）   |
| 用户开启手机远控                       | `wss://zcode.z.ai/api/v1/remote/ws2`、`/api/v1/remote/device`、通知接口（中继经智谱服务器；审计未见端到端加密） | 远控协议自带设备标识 |
| 用户点「分享对话」                     | 分享接口（上传所分享的对话内容）                                                                                | 带（已登录）         |
| 用户提交反馈                           | 反馈接口与附件上传（OSS）                                                                                       | 按反馈接口要求       |
| 用户使用语音输入                       | `/api/v1/asr/tickets` 及实时识别                                                                                | 带（已登录）         |
| 智能体调用搜图插件（默认启用、需登录） | 搜图接口                                                                                                        | 带（已登录）         |
| 用户用建站插件发布网站                 | `/api/v1/sites`                                                                                                 | 带（已登录）         |
| 用户打开插件商店并点刷新               | `cdn-zcode.z.ai` 官方目录；Claude 官方市场走 GitHub                                                             | 不带                 |
| 用户打开设置/商店中的官方插件列表      | `cdn-zcode.z.ai` 插件图标                                                                                       | 不带                 |
| 还没改完的内置供应商列表下发（见下）   | `zcode.z.ai /api/v1/client/configs` + CDN                                                                       | 未登录时也会请求     |

不经智谱的：用户自己配置的其他 AI 服务、Bot（飞书/Telegram/微信/Webhook）、浏览器与网页抓取工具访问的网站。记忆只存本机；网页搜索用所选模型自带的搜索。

## 待处理（不在本路改动范围）

| 项                            | 位置                                                                                                                                                                                                                                                                         | 建议改法                                                                                                                                       |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 内置供应商列表远程下发（App） | `packages/provider-node/src/zcode-builtin-download.ts:57-64`（`packages/services/src/model-provider/zcodeBuiltinRemoteConfig.ts` 调用）                                                                                                                                      | 在 `downloadZCodeBuiltinRelease` 解析出 authorization 后加 `if (!authorization && isPrivacyMode()) return null;`，继续用安装包内置的供应商配置 |
| 内置供应商列表远程下发（CLI） | `apps/zcode-cli/packages/bootstrap/src/app/process-provider-registry-runtime.ts:73`                                                                                                                                                                                          | 隐私模式下不传 `zcodeBuiltinRemote`（只用 bundled 文件），或复用上面同一守卫                                                                   |
| CLI 的设备 ID 头              | CLI 侧 `zcode-source-headers`（`X-Device-Mid` 拼装处）                                                                                                                                                                                                                       | 与 App 侧一致：只在请求带 Authorization 时附带 `X-Device-Mid`                                                                                  |
| 搜图、建站插件默认关          | `apps/zcode-cli/packages/bootstrap/src/app/official-plugin-definitions.ts`（`defaultEnabled`），并同步 `packages/shared/src/plugin-marketplaces.ts` 与 `packages/services/src/plugins/officialPluginCache.ts` 的 `DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS`（CLI 有机械对照单测） | 隐私模式下从默认启用集合里去掉 `image-search`、`zcode-site`；用户仍可在设置里手动开启                                                          |
| 官方插件图标打包本地          | CLI `official-plugin-definitions.ts` 的 `OFFICIAL_PLUGIN_ASSETS_BASE_URL`                                                                                                                                                                                                    | 把内置官方插件图标随包分发，隐私模式下用本地路径                                                                                               |

## 宣传措辞建议

- 可以说：「默认不向智谱发送设备 ID，未登录时不连智谱服务器拉配置、不弹营销；开源构建不含遥测、崩溃上报、自动更新。」——前提是上表「待处理」完成；完成前须补一句「内置模型列表仍会在启动时从智谱拉取一次」。
- 必须写明：登录、手机远控、分享、反馈、语音、搜图/建站插件会经过智谱服务器。
- 不要说「完全不联网」或「不经过任何第三方」。

## 测试与构建注意

- E2E 夹具里依赖营销弹窗、`client/configs`、`client/scenes` 的用例需在构建和运行时都设 `ZCODE_PRIVACY_MODE=0`。
- 内部仓库若存在 `config/private/build-defaults.json`，隐私模式构建会失败，需显式 `ZCODE_PRIVACY_MODE=0`。
