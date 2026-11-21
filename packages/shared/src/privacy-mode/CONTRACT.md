# privacy-mode

意图：一个开关统一控制「除用户自选 AI 服务和用户主动发起的功能外，客户端不主动连智谱服务器、不发设备 ID」。

不变量：

- 默认开启；只有 `ZCODE_PRIVACY_MODE` 显式为 `0/false/off/no` 才关闭，恢复上游行为。
- 求值优先级：运行时环境变量 > 构建期注入的 `__ZCODE_PRIVACY_MODE__`（`scripts/build-time-config.mjs`）> 开启。Renderer 没有 `process`，只看构建期值。
- 无状态、无持久化。各调用点自己守卫并注释 `// acp-bridge(privacy):`，本模块不拦截网络。
- 用户主动功能（登录、远控、分享、反馈、语音）不受它约束。
- 清单与仍会出网的情况见 docs/acp-bridge/PRIVACY.md；回归取样 `pnpm --filter @zcode/desktop test:privacy-mode`。
