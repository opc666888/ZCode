import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, win32 } from "node:path";
import { setDataBaseDir } from "@zcode/services/node";
import { ZCODE_C360 } from "@zcode/shared";
import { app, dialog, net, shell } from "electron";

export function resolveBootstrapSettingsFile(homePath: string = process.env.ZCODE_DATA_BASE_DIR?.trim() || homedir()): string {
  return join(homePath, ".zcode", "v2", "setting.json");
}

export function extractBootstrapDataBaseDir(rawValue: unknown): string | null {
  if (!rawValue || typeof rawValue !== "object") {
    return null;
  }

  const dataBaseDir = (rawValue as { dataBaseDir?: unknown }).dataBaseDir;
  if (typeof dataBaseDir !== "string") {
    return null;
  }

  const trimmed = dataBaseDir.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readBootstrapDataBaseDirFromDisk(
  settingsFile: string = resolveBootstrapSettingsFile(),
): string | null {
  if (!existsSync(settingsFile)) {
    return null;
  }

  try {
    const raw = readFileSync(settingsFile, "utf-8");
    return extractBootstrapDataBaseDir(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Claude 360 Code 的数据根（项目、对话、设置都在它下面的 .zcode 里），和本机官方 ZCode 的 ~/.zcode 分开（owner 11-22）。 */
export function c360DataBaseDir(homePath: string = homedir()): string {
  return join(homePath, ".claude360code");
}

export function applyEarlyDataBaseDirBootstrap(): string | null {
  if (ZCODE_C360 && !process.env.ZCODE_DATA_BASE_DIR?.trim()) {
    // 不读官方 ZCode 的 ~/.zcode/v2/setting.json；子进程（CLI）也靠这个环境变量落到同一个数据根
    const base = c360DataBaseDir();
    process.env.ZCODE_DATA_BASE_DIR = base;
    process.env.ZCODE_C360_RUNTIME = "1"; // CLI 子进程按它用 Claude 360 Code 自己的钥匙串条目
    // owner 11-22：插件市场、自动化模板等照上游正常连智谱，隐私模式默认关（用户自己设 ZCODE_PRIVACY_MODE=1 仍可打开）
    if (!process.env.ZCODE_PRIVACY_MODE?.trim()) process.env.ZCODE_PRIVACY_MODE = "0";
    setDataBaseDir(base);
    return base;
  }
  const dataBaseDir = readBootstrapDataBaseDirFromDisk();
  if (dataBaseDir) {
    // 启动早期就把 dataBaseDir 注入进来，避免 logger / crashReporter 先按默认 HOME 建目录，
    // 导致后续再切换到自定义目录时，日志和 crash dump 落在两套路径里。
    setDataBaseDir(dataBaseDir);
  }
  return dataBaseDir;
}

// Claude 360 Code 授权门（owner 2026-11-22）：要这台电脑的 Claude 360 Manager 已经用授权码（或已开通的账号）
// 激活过才能用。判断依据是 Manager 激活后写的本机身份文件 ExclusiveEnv/state.json（有 deviceId / kid）。
// 只拦普通用户：真正的价值在我们给客户配的 Claude Code、固定 IP 和网络接管，没授权就不配。
const MANAGER_DOWNLOAD_URL = "https://env.opentools.site/download/";

export function managerStateFile(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  if (platform === "win32") {
    const appData = env.APPDATA?.trim() || win32.join(home, "AppData", "Roaming");
    return win32.join(appData, "ExclusiveEnv", "state.json");
  }
  return join(home, "Library", "Application Support", "ExclusiveEnv", "state.json");
}

export function isManagerActivated(file: string = managerStateFile()): boolean {
  try {
    const state = JSON.parse(readFileSync(file, "utf8")) as { deviceId?: unknown; kid?: unknown };
    return typeof state.deviceId === "string" && state.deviceId.length > 0 && typeof state.kid === "string";
  } catch {
    return false;
  }
}

/** 返回 true = 可以继续启动；false = 用户选了退出（已调用 app.quit）。 */
export async function ensureC360License(): Promise<boolean> {
  if (!ZCODE_C360) return true;
  for (;;) {
    if (isManagerActivated()) return true;
    const { response } = await dialog.showMessageBox({
      type: "warning",
      title: "需要 Claude 360 授权",
      message: "这台电脑还没有激活 Claude 360",
      detail:
        "Claude 360 Code 要配合已激活的 Claude 360 Manager 使用。\n\n" +
        "请先打开 Claude 360 Manager，用授权码（或已开通的账号）激活这台电脑，激活好了回来点「重新检查」。\n\n" +
        "还没有授权码？请联系顾问开通 Claude 360。",
      buttons: ["重新检查", "下载 Claude 360 Manager", "退出"],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });
    if (response === 1) {
      void shell.openExternal(MANAGER_DOWNLOAD_URL);
      continue;
    }
    if (response === 2) {
      app.quit();
      return false;
    }
  }
}

/**
 * Claude 360 Code 升级提示（owner 2026-11-27「升级的肯定要做」）。
 *
 * C360 构建关掉了官方自动更新（开着会把应用换回官方 ZCode），老用户就不知道有新版。
 * 这里改成：启动 15 秒后、之后每 6 小时，向我们自己的下载站读一个公开的版本号文件；
 * 比当前版本新就弹一次窗「去下载」，打开下载页让用户自己下载覆盖安装。不自动下载、不自动安装。
 *
 * 防泄露铁律（docs/c360/RELEASE-NO-LEAK.md）：只请求 env.opentools.site（我们自己的域名，不是 Claude/Anthropic），
 * 走 Electron net.fetch（Chromium 网络栈，跟系统代理 / 接管走同一条路），不带任何设备标识或凭据；
 * 不改任何网络设置。请求失败一律静默，不影响使用。
 */

export const C360_LATEST_URL = "https://env.opentools.site/c360code/latest.json";
export const C360_DOWNLOAD_URL = "https://env.opentools.site/download/";
const FIRST_CHECK_DELAY_MS = 15_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

export interface C360LatestInfo {
  version: string;
  notes?: string;
}

/** 只认 x.y.z 数字版本；格式不对返回 undefined（当作没有新版）。 */
export function parseVersion(value: unknown): [number, number, number] | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

export function isNewerVersion(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a[i]! !== b[i]!) return a[i]! > b[i]!;
  }
  return false;
}

export function parseLatestInfo(body: unknown): C360LatestInfo | undefined {
  if (!body || typeof body !== "object") return undefined;
  const record = body as Record<string, unknown>;
  if (!parseVersion(record.version)) return undefined;
  const notes = typeof record.notes === "string" ? record.notes.trim().slice(0, 600) : undefined;
  return { version: String(record.version).trim(), ...(notes ? { notes } : {}) };
}

/** 测试用覆盖地址：只接受 https，或本机 127.0.0.1（测试电脑上起的临时文件服务）。 */
export function resolveLatestUrl(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.C360_UPDATE_LATEST_URL?.trim();
  if (override && (override.startsWith("https://") || /^http:\/\/127\.0\.0\.1(:\d+)?\//.test(override))) return override;
  return C360_LATEST_URL;
}

async function fetchLatest(url: string): Promise<C360LatestInfo | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await net.fetch(url, {
      signal: controller.signal,
      credentials: "omit",
      headers: { Accept: "application/json", "Cache-Control": "no-cache" },
    });
    if (!response.ok) return undefined;
    return parseLatestInfo(await response.json());
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

export interface C360UpdateNoticeLogger {
  info(message: string): void;
}

/** 启动升级检查；返回停止函数。同一个新版本本次运行只提醒一次，点「稍后」下次启动再提醒。 */
export function startC360UpdateNotice(logger: C360UpdateNoticeLogger): () => void {
  const url = resolveLatestUrl();
  const prompted = new Set<string>();
  let dialogOpen = false;

  const check = async () => {
    if (dialogOpen) return;
    const latest = await fetchLatest(url);
    const current = app.getVersion();
    if (!latest || !isNewerVersion(latest.version, current) || prompted.has(latest.version)) return;
    prompted.add(latest.version);
    logger.info(`[c360-update] 发现新版本 ${latest.version}（当前 ${current}），提示用户`);
    dialogOpen = true;
    try {
      const { response } = await dialog.showMessageBox({
        type: "info",
        title: "Claude 360 Code 有新版本",
        message: `发现新版本 ${latest.version}（你现在用的是 ${current}）`,
        detail:
          (latest.notes ? `${latest.notes}\n\n` : "") +
          "点「去下载」打开下载页，登录后下载新安装包，直接覆盖安装就行；你的项目和对话记录都会保留。",
        buttons: ["去下载", "稍后提醒"],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      if (response === 0) void shell.openExternal(C360_DOWNLOAD_URL);
    } finally {
      dialogOpen = false;
    }
  };

  const first = setTimeout(() => void check(), FIRST_CHECK_DELAY_MS);
  const timer = setInterval(() => void check(), CHECK_INTERVAL_MS);
  first.unref?.();
  timer.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
