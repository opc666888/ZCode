#!/usr/bin/env bash
# 构建 ZCode Agent CLI（apps/zcode-cli），产物可被桌面开发版和 smoke.mjs 直接拉起。
# 走仓库自带的 scripts/build-desktop-agent-cli.mjs（与 pnpm dev:desktop 同一条构建链），
# 产物：apps/zcode-cli/packages/cli/dist/zcode.cjs，并暂存到 packages/desktop/bundled-agents/。
# 用法：bash scripts/acp-dev/build-cli.sh [--quick]
#   --quick  只重建 acp-engine / core / adapters / bootstrap / cli（跳过插件运行时），用于改完 W1/W2 代码后快速迭代。
set -euo pipefail
# shellcheck disable=SC1091
. "$(dirname "$0")/env.sh"
cd "$ACP_DEV_REPO_ROOT"

QUICK=0
[ "${1:-}" = "--quick" ] && QUICK=1

LOG="$ACP_DEV_LOG_DIR/build-cli-$(date +%Y%m%d-%H%M%S).log"
export TMPDIR="$ACP_DEV_SHORT_TMP"
export ZCODE_ENV="${ZCODE_ENV:-production}"   # 与 pnpm dev:desktop 默认一致
export PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false
start=$(date +%s)
echo "[acp-dev] 构建 Agent CLI（quick=${QUICK}, ZCODE_ENV=${ZCODE_ENV}），日志：${LOG}"

{
  # acp-engine 是新包：若已有 package.json 且带 build 脚本，先构建（W1 产物，未就绪时跳过）。
  ENGINE_PKG="apps/zcode-cli/packages/acp-engine/package.json"
  if [ -f "$ENGINE_PKG" ] && node -e 'const p=require("./'"$ENGINE_PKG"'");process.exit(p.scripts&&p.scripts.build?0:1)'; then
    ENGINE_NAME="$(node -p 'require("./'"$ENGINE_PKG"'").name')"
    echo "[acp-dev] 构建 ${ENGINE_NAME}"
    "${ACP_DEV_PNPM[@]}" --filter "$ENGINE_NAME" build
  else
    echo "[acp-dev] acp-engine 尚无可构建的 package.json，跳过"
  fi

  if [ "$QUICK" = "1" ]; then
    for f in @zcode/shared-types @zcode/contracts @zcode/core @zcode/adapters @zcode/bootstrap; do
      "${ACP_DEV_PNPM[@]}" --filter "$f" build
    done
    "${ACP_DEV_PNPM[@]}" --filter @zcode/cli build:desktop-agent
  else
    node scripts/build-desktop-agent-cli.mjs
  fi
} 2>&1 | tee "$LOG"

end=$(date +%s)
ENTRY="$ACP_DEV_REPO_ROOT/apps/zcode-cli/packages/cli/dist/zcode.cjs"
if [ ! -f "$ENTRY" ]; then
  echo "[acp-dev] 构建结束但缺少 ${ENTRY}" >&2
  exit 1
fi
echo "[acp-dev] 完成，用时 $((end - start)) 秒；入口：${ENTRY}"
echo "BUILD_CLI_SECONDS=$((end - start))" >> "$LOG"
