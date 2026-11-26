#!/usr/bin/env node
// 电脑操作插件的启动器：按当前系统找到随包的 Open Computer Use 原生程序，原样转发参数与标准输入输出。
// 默认参数 mcp = 9 个工具的 stdio MCP 服务；也可传 doctor（Mac 权限自查 + 弹授权引导）等原生子命令。
// 原生程序由打包脚本（packages/desktop/scripts/open-computer-use-assets.mjs）放进 dist/ocu/。
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function resolveOpenComputerUseBinary(root = pluginRoot, platform = process.platform) {
  if (platform === "darwin") {
    return join(root, "dist", "ocu", "Open Computer Use.app", "Contents", "MacOS", "OpenComputerUse");
  }
  if (platform === "win32") {
    return join(root, "dist", "ocu", "open-computer-use.exe");
  }
  return null;
}

function main() {
  const binary = resolveOpenComputerUseBinary();
  if (!binary) {
    process.stderr.write(`电脑操作暂不支持这个系统（${process.platform}），只支持 Mac 和 Windows。\n`);
    return 1;
  }
  if (!existsSync(binary)) {
    process.stderr.write(`电脑操作的程序文件缺失：${binary}。请重新安装 Claude 360 Code。\n`);
    return 1;
  }
  const args = process.argv.slice(2);
  const child = spawn(binary, args.length > 0 ? args : ["mcp"], {
    stdio: "inherit",
    windowsHide: true,
  });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => {
      if (!child.killed) child.kill(signal);
    });
  }
  child.on("error", (error) => {
    process.stderr.write(`电脑操作启动失败：${error.message}\n`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    process.exit(code ?? (signal ? 1 : 0));
  });
  return undefined;
}

const code = main();
if (typeof code === "number") process.exitCode = code;
