#!/usr/bin/env bash
# 以隔离数据目录启动 ZCode 桌面开发版（生产构建 + 未打包的 Electron），与本机正式版 /Applications/ZCode.app 并排运行互不干扰。
#
# 用法：
#   bash scripts/acp-dev/run-desktop-isolated.sh build     # 构建桌面（runtime assets + tsup + vite build），首次或改了桌面代码后跑
#   bash scripts/acp-dev/run-desktop-isolated.sh start     # 后台启动（经 open/LaunchServices）；PID/日志写在隔离根 logs/ 下
#        ... start --direct [--no-sandbox]                 # 作为当前 shell 的子进程启动
#   bash scripts/acp-dev/run-desktop-isolated.sh status    # 看是否在跑 + 隔离核验结果
#   bash scripts/acp-dev/run-desktop-isolated.sh stop      # 关闭（SIGTERM，5 秒后 SIGKILL）
#   bash scripts/acp-dev/run-desktop-isolated.sh shot [名字] # 只截开发版窗口，存 docs/acp-bridge/screenshots/<名字>.png
#   bash scripts/acp-dev/run-desktop-isolated.sh fg        # 前台启动（日志直接打到终端，Ctrl+C 关闭）
#
# 为什么不用 pnpm dev:desktop：它走 vite dev（固定端口 5174）+ 远程调试固定端口 9229 + 带 zcode:// 声明的 Dev.app 副本，
# 都是全机共享资源。这里改成一次性生产构建、直接起 node_modules 里的原版 Electron，并加载隔离护栏
# （electron-isolation-guard.cjs：拦截 zcode:// 默认协议注册、mock 钥匙串、启动后核验路径不在隔离根就退出）。
#
# 隔离清单（全部指向 $ACP_DEV_ROOT，默认 <项目工作区>/workspace-runtime/tmp/20261119-zcode-acp）：
#   ZCODE_DESKTOP_APPLICATION_NAME="ZCode ACP Dev"   → 与正式版 app name 不同，单实例锁互不影响
#   ZCODE_DESKTOP_USER_DATA_DIR=$ACP_DEV_ROOT/electron-userdata
#   ZCODE_DATA_BASE_DIR=$ACP_DEV_ROOT/data            → Host 的 ~/.zcode/v2 等
#   HOME / ZCODE_DESKTOP_HOME_DIR=$ACP_DEV_ROOT/home  → Agent CLI 的 ~/.zcode/cli（会话库、日志、插件）按 HOME 解析，必须隔离
#   TMPDIR=~/.zacp-tmp（软链 → $ACP_DEV_ROOT/tmpdir） → Unix socket 路径不超长，文件仍落在隔离根
#   ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT=1       → 不占 9229
set -euo pipefail
# shellcheck disable=SC1091
. "$(dirname "$0")/env.sh"
cd "$ACP_DEV_REPO_ROOT"

DESKTOP_DIR="$ACP_DEV_REPO_ROOT/packages/desktop"
PID_FILE="$ACP_DEV_LOG_DIR/desktop.pid"
APP_NAME="ZCode ACP Dev"
GUARD="$ACP_DEV_REPO_ROOT/scripts/acp-dev/electron-isolation-guard.cjs"
SHOT_DIR="$ACP_DEV_REPO_ROOT/docs/acp-bridge/screenshots"

electron_bin() {
  (cd "$DESKTOP_DIR" && node -p "require('electron')" 2>/dev/null | tail -1)
}

is_running() {
  [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null
}

cmd_build() {
  local log="$ACP_DEV_LOG_DIR/build-desktop-$(date +%Y%m%d-%H%M%S).log"
  local start end
  start=$(date +%s)
  echo "[acp-dev] 构建桌面，日志：${log}"
  (
    export TMPDIR="$ACP_DEV_SHORT_TMP"
    export ZCODE_ENV="${ZCODE_ENV:-production}"
    export PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false
    cd "$DESKTOP_DIR"
    node scripts/ensure-local-runtime-assets.mjs
    "${ACP_DEV_PNPM[@]}" run build:no-runtime-assets
  ) 2>&1 | tee "$log"
  end=$(date +%s)
  for f in out/main/index.js out/host/index.js out/renderer/index.html; do
    [ -f "$DESKTOP_DIR/$f" ] || { echo "[acp-dev] 构建后缺少 ${f}" >&2; exit 1; }
  done
  echo "[acp-dev] 桌面构建完成，用时 $((end - start)) 秒"
  echo "BUILD_DESKTOP_SECONDS=$((end - start))" >> "$log"
}

preflight() {
  [ -f "$DESKTOP_DIR/out/main/index.js" ] || { echo "[acp-dev] 未构建桌面，先跑：$0 build" >&2; exit 1; }
  local agent="$DESKTOP_DIR/bundled-agents/$(node -p 'process.platform+"-"+process.arch')/glm/zcode.cjs"
  [ -f "$agent" ] || { echo "[acp-dev] 未暂存 Agent CLI，先跑：bash scripts/acp-dev/build-cli.sh" >&2; exit 1; }
  ELECTRON="$(electron_bin)"
  [ -x "$ELECTRON" ] || { echo "[acp-dev] 找不到 Electron 可执行文件：${ELECTRON}" >&2; exit 1; }
  if [ "$ACP_DEV_USERDATA_DIR" = "$HOME/Library/Application Support/ZCode" ]; then
    echo "[acp-dev] 拒绝：userData 指向了正式版目录" >&2; exit 1
  fi
}

print_isolation() {
  echo "[acp-dev] 隔离路径："
  echo "  app name            = $APP_NAME"
  echo "  userData            = $ACP_DEV_USERDATA_DIR"
  echo "  ZCODE_DATA_BASE_DIR = $ACP_DEV_DATA_DIR"
  echo "  HOME                = $ACP_DEV_HOME_DIR"
  echo "  TMPDIR              = $ACP_DEV_SHORT_TMP -> $(readlink "$ACP_DEV_SHORT_TMP")"
  echo "  Electron            = $ELECTRON"
}

# 启动方式：
#   默认经 `open -n`（LaunchServices）拉起，进程不是当前 shell 的子进程——在受沙箱限制的自动化会话里，
#   直接 fork 出来的 Electron 子进程初始化 Chromium 沙箱会失败（GPU 进程反复崩溃后 FATAL），open 不受影响。
#   --direct 直接作为子进程启动（普通终端里也可用）；--direct --no-sandbox 关闭 Chromium 沙箱（仅本地调试用）。
#   open 启动的进程不继承当前 shell 环境，所以所有变量都显式经 --env 传入。
ENV_PAIRS=()
build_env_pairs() {
  ENV_PAIRS=(
    "ACP_DEV_ROOT=$ACP_DEV_ROOT"
    "PATH=$PATH"
    "LANG=${LANG:-zh_CN.UTF-8}"
    "HOME=$ACP_DEV_HOME_DIR"
    "USERPROFILE=$ACP_DEV_HOME_DIR"
    "TMPDIR=$ACP_DEV_SHORT_TMP"
    "ZCODE_ENV=${ZCODE_ENV:-production}"
    "ZCODE_DATA_BASE_DIR=$ACP_DEV_DATA_DIR"
    "ZCODE_DESKTOP_APPLICATION_NAME=$APP_NAME"
    "ZCODE_DESKTOP_USER_DATA_DIR=$ACP_DEV_USERDATA_DIR"
    "ZCODE_DESKTOP_HOME_DIR=$ACP_DEV_HOME_DIR"
    "ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT=1"
    "NODE_OPTIONS=--require=$GUARD"
  )
  # GUI 验证：目录选择对话框自动返回该目录（只接受隔离根内路径，见 electron-isolation-guard.cjs）。
  [ -n "${ACP_DEV_AUTO_SELECT_DIR:-}" ] && ENV_PAIRS+=("ACP_DEV_AUTO_SELECT_DIR=$ACP_DEV_AUTO_SELECT_DIR")
  # 代理等网络变量原样透传（开发版访问网络沿用当前 shell 的出口设置）。
  local v
  for v in HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy ALL_PROXY all_proxy; do
    [ -n "${!v:-}" ] && ENV_PAIRS+=("$v=${!v}")
  done
  return 0
}

cmd_start() {
  local mode="open" extra=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --direct) mode="direct" ;;
      --no-sandbox) extra+=("--no-sandbox") ;;
      --*) extra+=("$1") ;;   # 其余 -- 开头的参数原样传给 Electron（如 --remote-debugging-port=0）
      *) echo "[acp-dev] 未知参数 $1" >&2; exit 1 ;;
    esac
    shift
  done
  if is_running; then echo "[acp-dev] 已在运行，PID $(cat "$PID_FILE")"; return 0; fi
  rm -f "$PID_FILE"
  preflight
  print_isolation
  build_env_pairs
  local log="$ACP_DEV_LOG_DIR/desktop-$(date +%Y%m%d-%H%M%S).log"
  : > "$log"
  ln -sf "$log" "$ACP_DEV_LOG_DIR/desktop-latest.log"
  if [ "$mode" = "open" ]; then
    local app_bundle="${ELECTRON%/Contents/MacOS/*}"
    local open_args=(-n -a "$app_bundle" --stdout "$log" --stderr "$log")
    local pair
    for pair in "${ENV_PAIRS[@]}"; do open_args+=(--env "$pair"); done
    open "${open_args[@]}" --args "$DESKTOP_DIR" ${extra[@]+"${extra[@]}"}
  else
    # nohup：不随当前终端/会话退出；不碰 launchd。
    (cd "$DESKTOP_DIR" && env -i "${ENV_PAIRS[@]}" nohup "$ELECTRON" "$DESKTOP_DIR" ${extra[@]+"${extra[@]}"} \
      > "$log" 2>&1 < /dev/null 3>&- 4>&- 5>&- &)
  fi
  echo "[acp-dev] 已发起启动（${mode}），日志：${log}"
  # 等护栏输出核验结果（最多 60 秒）；PID 由护栏写入 $PID_FILE。
  for _ in $(seq 1 120); do
    if grep -q "隔离核验通过" "$log" 2>/dev/null && [ -f "$PID_FILE" ]; then
      sed -n '/实际路径/,/隔离核验通过/p' "$log" | sed 's/sandbox initialization failed.*//; s/Failed to initialize sandbox\.//g'
      # 核验通过后再观察 8 秒，确认 GPU/渲染进程没有起不来（受限会话里 Chromium 沙箱会失败，见 --no-sandbox）。
      sleep 8
      if grep -q "FATAL" "$log" || ! is_running; then
        echo "[acp-dev] 启动后崩溃，日志尾部：" >&2; grep -E "FATAL|sandbox initialization failed" "$log" | tail -3 >&2
        echo "[acp-dev] 若看到 sandbox initialization failed：当前进程处在受限沙箱里（如自动化会话），改用 start --direct --no-sandbox，或在自己的终端里运行。" >&2
        cmd_stop >/dev/null 2>&1 || true
        return 1
      fi
      echo "[acp-dev] 运行中 PID $(cat "$PID_FILE")；关闭：bash scripts/acp-dev/run-desktop-isolated.sh stop"
      return 0
    fi
    if grep -qE "隔离核验失败|拒绝启动|FATAL" "$log" 2>/dev/null; then
      echo "[acp-dev] 启动失败，日志尾部：" >&2; tail -40 "$log" >&2
      cmd_stop >/dev/null 2>&1 || true
      return 1
    fi
    sleep 0.5
  done
  echo "[acp-dev] 60 秒内没看到护栏核验输出，请看日志：${log}" >&2
  return 1
}

cmd_fg() {
  preflight
  print_isolation
  build_env_pairs
  cd "$DESKTOP_DIR" && exec env -i "${ENV_PAIRS[@]}" "$ELECTRON" "$DESKTOP_DIR" "$@"
}

cmd_stop() {
  if ! is_running; then echo "[acp-dev] 未在运行"; rm -f "$PID_FILE"; return 0; fi
  local pid; pid="$(cat "$PID_FILE")"
  kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 10); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
  kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null || true
  rm -f "$PID_FILE"
  echo "[acp-dev] 已关闭 PID ${pid}"
}

cmd_status() {
  if is_running; then
    echo "[acp-dev] 运行中 PID $(cat "$PID_FILE")"
    grep -E "隔离核验|已拦截" "$ACP_DEV_LOG_DIR/desktop-latest.log" 2>/dev/null | tail -5 || true
  else
    echo "[acp-dev] 未运行"
  fi
}

# 只截开发版自己的窗口：按 PID 在 CGWindowList 里找窗口号，再 screencapture -l，绝不截全屏。
cmd_shot() {
  is_running || { echo "[acp-dev] 未运行" >&2; exit 1; }
  local name="${1:-desktop-$(date +%Y%m%d-%H%M%S)}"
  mkdir -p "$SHOT_DIR"
  local wid
  wid="$(python3 - "$(cat "$PID_FILE")" <<'PY'
import sys, Quartz
pid = int(sys.argv[1])
wins = Quartz.CGWindowListCopyWindowInfo(Quartz.kCGWindowListOptionOnScreenOnly, Quartz.kCGNullWindowID)
best = None
for w in wins:
    if w.get("kCGWindowOwnerPID") != pid or w.get("kCGWindowLayer", 1) != 0:
        continue
    b = w.get("kCGWindowBounds", {})
    area = b.get("Width", 0) * b.get("Height", 0)
    if best is None or area > best[0]:
        best = (area, w.get("kCGWindowNumber"))
print(best[1] if best else "")
PY
)"
  [ -n "$wid" ] || { echo "[acp-dev] 没找到开发版（PID $(cat "$PID_FILE")）的屏幕窗口" >&2; exit 1; }
  screencapture -x -o -l "$wid" "$SHOT_DIR/$name.png"
  echo "$SHOT_DIR/$name.png"
}

case "${1:-}" in
  build) cmd_build ;;
  start) shift; cmd_start "$@" ;;
  fg) shift; cmd_fg "$@" ;;
  stop) cmd_stop ;;
  status) cmd_status ;;
  shot) shift; cmd_shot "$@" ;;
  *) sed -n '2,11p' "$0"; exit 1 ;;
esac
