// Claude 360 Code 授权门（owner 2026-11-22）：要这台电脑的 Claude 360 Manager 已经用授权码（或已开通的账号）
// 激活过才能用。判断依据是 Manager 激活后写的本机身份文件 ExclusiveEnv/state.json（有 deviceId / kid）。
// 只拦普通用户：真正的价值在我们给客户配的 Claude Code、固定 IP 和网络接管，没授权就不配。
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, win32 } from "node:path";
import { ZCODE_C360 } from "@zcode/shared";
import { app, dialog, shell } from "electron";

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
