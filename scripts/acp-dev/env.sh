#!/usr/bin/env bash
# ACP Bridge 本地开发的公共环境：仓库根、隔离目录、Node 24。
# 被 build-cli.sh / run-desktop-isolated.sh / smoke 包装脚本 source。
# 硬性约束：所有运行期数据只落在 ACP_DEV_ROOT 下，不碰 ~/.zcode、正式版 userData、launchd、钥匙串。

ACP_DEV_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export ACP_DEV_REPO_ROOT

# 默认隔离根：<项目工作区>/workspace-runtime/tmp/20261119-zcode-acp（仓库在 <项目工作区>/zcode-acp）。
# 可用 ACP_DEV_ROOT 覆盖，但禁止指向 $HOME 本身或 /tmp。
: "${ACP_DEV_ROOT:="$(cd "$ACP_DEV_REPO_ROOT/.." && pwd)/workspace-runtime/tmp/20261119-zcode-acp"}"
case "$ACP_DEV_ROOT" in
  "$HOME"|"$HOME/"|/tmp|/tmp/*|/private/tmp/*|/var/folders/*)
    echo "[acp-dev] 拒绝：ACP_DEV_ROOT 不能是 \$HOME 或系统临时目录：${ACP_DEV_ROOT}" >&2
    return 1 2>/dev/null || exit 1 ;;
esac
export ACP_DEV_ROOT
export ACP_DEV_DATA_DIR="$ACP_DEV_ROOT/data"           # ZCODE_DATA_BASE_DIR，=> $ACP_DEV_DATA_DIR/.zcode
export ACP_DEV_HOME_DIR="$ACP_DEV_ROOT/home"           # 子进程 HOME（隔离 ~/.zcode/AGENTS.md 等按 HOME 解析的路径）
export ACP_DEV_USERDATA_DIR="$ACP_DEV_ROOT/electron-userdata"
export ACP_DEV_LOG_DIR="$ACP_DEV_ROOT/logs"
export ACP_DEV_TMP_DIR="$ACP_DEV_ROOT/tmpdir"           # 子进程 TMPDIR 的真实位置（owner 规则：不写系统 /tmp）
mkdir -p "$ACP_DEV_DATA_DIR" "$ACP_DEV_HOME_DIR" "$ACP_DEV_USERDATA_DIR" "$ACP_DEV_LOG_DIR" "$ACP_DEV_TMP_DIR"

# macOS Unix socket 路径上限 104 字节；隔离目录含中文太长，CLI/Chromium 在 TMPDIR 下建 socket 会失败。
# 用短软链（默认 ~/.zacp-tmp）指向隔离 tmpdir：文件实际仍落在隔离根，HOME 下只多一个软链。
: "${ACP_DEV_SHORT_TMP:="$HOME/.zacp-tmp"}"
if [ -L "$ACP_DEV_SHORT_TMP" ]; then
  if [ "$(readlink "$ACP_DEV_SHORT_TMP")" != "$ACP_DEV_TMP_DIR" ]; then
    echo "[acp-dev] ${ACP_DEV_SHORT_TMP} 指向别处，请手动处理或设 ACP_DEV_SHORT_TMP" >&2
    return 1 2>/dev/null || exit 1
  fi
elif [ -e "$ACP_DEV_SHORT_TMP" ]; then
  echo "[acp-dev] ${ACP_DEV_SHORT_TMP} 已存在且不是软链，请手动处理或设 ACP_DEV_SHORT_TMP" >&2
  return 1 2>/dev/null || exit 1
else
  ln -s "$ACP_DEV_TMP_DIR" "$ACP_DEV_SHORT_TMP"
fi
export ACP_DEV_SHORT_TMP

# Node 24（仓库要求）。nvm 不存在时沿用当前 node，但会校验主版本。
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
  nvm use 24 >/dev/null 2>&1 || true
fi
ACP_DEV_NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$ACP_DEV_NODE_MAJOR" != "24" ]; then
  echo "[acp-dev] 需要 Node 24，当前 $(node -v 2>/dev/null || echo 无)" >&2
  return 1 2>/dev/null || exit 1
fi
export ACP_DEV_NODE_BIN="$(command -v node)"

# pnpm：优先全局 pnpm，其次 npx 固定版本（与 INFLIGHT 记录一致）。
if command -v pnpm >/dev/null 2>&1; then
  ACP_DEV_PNPM=(pnpm)
else
  ACP_DEV_PNPM=(npx -y pnpm@10.33.2)
fi

# 从 ZCode 客户端终端里启动时会继承正式版的运行时环境，必须清掉，避免把正式版身份/地址带进开发版。
unset ZCODE_BASE_URL ZCODE_RUNTIME_ENV ZCODE_DESKTOP_APPLICATION_NAME ZCODE_DESKTOP_USER_DATA_DIR \
      ZCODE_DESKTOP_SESSION_DATA_DIR ZCODE_DESKTOP_HOME_DIR ZCODE_DESKTOP_USE_ELECTRON_DEFAULT_USER_DATA \
      ZCODE_AGENT_SERVER_COMMAND ZCODE_AGENT_SERVER_ARGS_JSON ZCODE_AGENT_SERVER_CWD
