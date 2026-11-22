import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setDataBaseDir } from "@zcode/services/node";
import { ZCODE_C360 } from "@zcode/shared";

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
