# 打 Claude 360 Code 安装包（Mac / Windows）

> ⛔ 发版前必须先过 [RELEASE-NO-LEAK.md](RELEASE-NO-LEAK.md)（覆盖升级 + 泄露核对），不过不发。

Claude 360 Code = 本仓库在 `ZCODE_C360_IDENTITY=1` 下打出的发行版（2026-11-21 起）。和原版 ZCode 的区别只在构建开关：

| 项 | 做法 |
|---|---|
| 名字、系统身份 | `Claude 360 Code`，appId `site.opentools.c360code`（`packages/desktop/scripts/desktop-product-identity.mjs`）；运行行为沿用 preview（不接 ZCode 官方自动更新） |
| 图标 | `packages/desktop/build/icon*`（暖橙代码符号，官网风格） |
| 打开不登录 Z.AI | `packages/ui/src/lib/rootStartupGate.ts`：C360 构建不弹启动登录屏 |
| 界面文案 | `packages/ui/src/i18n/localeMessages.ts`：展示文字里的 ZCode 换成 Claude 360 Code；首页去掉 Z 底纹 |
| Claude 适配器 | 打包时装 `@agentclientprotocol/claude-agent-acp`（不含 200MB 平台程序）到 `resources/acp-claude/pkg/`；运行时用电脑上已装的 Claude Code（`~/.local/bin/claude`、Windows `~\.local\bin\claude.exe`，经 `CLAUDE_CODE_EXECUTABLE`） |

## 步骤（在 Mac 上，Windows 包也是交叉编译出来的）

```bash
# 0. 先重编 Agent CLI —— bundle.mjs 不会重编，改了 acp-engine 不做这步，包里就是旧代码（11-21 踩过）
ACP_DEV_SHORT_TMP=$HOME/.zacp-c360 bash scripts/acp-dev/build-cli.sh

cd packages/desktop
export ZCODE_ENV=production ZCODE_C360_IDENTITY=1 CSC_IDENTITY_AUTO_DISCOVERY=false \
       ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ \
       ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
# 构建机只能经代理出网时再加：
export ZCODE_PREBUILT_DOWNLOAD_PROXY_ALL=1

# 1. Mac
node scripts/bundle.mjs --os mac --arch arm64

# 2. Windows：需要 cmake 和 MinGW 编译器（brew 装不了时，用官方 cmake 的 macOS 包 + llvm-mingw 的 macOS 包，加进 PATH）
ZCODE_WINDOWS_CXX=x86_64-w64-mingw32-clang++ node scripts/bundle.mjs --os win --arch x64
```

产物在 `packages/desktop/dist/`：`Claude 360 Code-<版本>-mac-arm64.dmg/.zip`、`Claude 360 Code-<版本>-win-x64.exe`。没有签名（Mac 首次打开要右键→打开；Windows 会提示未知发布者）。

## 用户电脑上的前提

- 要先装 Claude Code（Claude 360 Manager 第 13 步「一键安装」会装，Mac / Windows 都支持）。没装时界面能打开、能选 Claude，但发消息会失败。
- 登录 Claude：第一次发消息时界面会给授权链接（「软件提示」），链接只在这个账号自己的指纹浏览器环境里打开。
