#!/usr/bin/env node
// 电脑操作插件的启动器：按当前系统找到随包的 Open Computer Use 原生程序，原样转发参数与标准输入输出。
// 默认参数 mcp = 9 个工具的 stdio MCP 服务；也可传 doctor（Mac 权限自查 + 弹授权引导）等原生子命令。
// 原生程序由打包脚本（packages/desktop/scripts/open-computer-use-assets.mjs）放进 dist/ocu/。
//
// 两种跑法：
// - 桌面版：官方插件的 MCP 经 Agent 的插件宿主（`zcode.cjs __zcode-plugin-host <本文件> mcp`）加载，
//   宿主 import 本模块并 await main()，main 一返回宿主就退出——所以 main 必须等原生程序结束才返回。
// - 直接 `node launch.mjs [参数]`：自己调 main。
import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const selfPath = fileURLToPath(import.meta.url);
const pluginRoot = join(dirname(selfPath), "..");

function resolveOpenComputerUseBinary(platform = process.platform) {
  if (platform === "darwin") {
    return join(pluginRoot, "dist", "ocu", "Open Computer Use.app", "Contents", "MacOS", "OpenComputerUse");
  }
  if (platform === "win32") {
    return join(pluginRoot, "dist", "ocu", "open-computer-use.exe");
  }
  return null;
}

export async function main() {
  const binary = resolveOpenComputerUseBinary();
  if (!binary) {
    process.stderr.write(`电脑操作暂不支持这个系统（${process.platform}），只支持 Mac 和 Windows。\n`);
    process.exitCode = 1;
    return;
  }
  if (!existsSync(binary)) {
    process.stderr.write(`电脑操作的程序文件缺失：${binary}。请重新安装 Claude 360 Code。\n`);
    process.exitCode = 1;
    return;
  }
  const args = process.argv.slice(2);
  // 宿主跑 MCP 时会设 ELECTRON_RUN_AS_NODE=1（给宿主自己用），原生程序不需要，去掉以免干扰。
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(binary, args.length > 0 ? args : ["mcp"], {
    env,
    stdio: "inherit",
    windowsHide: true,
  });
  const forward = (signal) => {
    if (child.exitCode === null && !child.killed) child.kill(signal);
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => forward(signal));
  process.on("exit", () => forward("SIGTERM"));
  await new Promise((resolve) => {
    child.on("error", (error) => {
      process.stderr.write(`电脑操作启动失败：${error.message}\n`);
      process.exitCode = 1;
      resolve();
    });
    child.on("exit", (code, signal) => {
      process.exitCode = code ?? (signal ? 1 : 0);
      resolve();
    });
  });
}

function isDirectRun() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(selfPath);
  } catch {
    return false;
  }
}

if (isDirectRun()) await main();
