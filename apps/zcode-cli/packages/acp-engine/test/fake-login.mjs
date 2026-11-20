#!/usr/bin/env node
/**
 * 测试用假登录命令：模仿 `claude-agent-acp --cli auth login --claudeai` 的输入输出，不联网。
 *   FAKE_LOGIN_LOG   把收到的参数和 BROWSER / NO_BROWSER 环境写成一行 JSON（断言「没让它开浏览器」）
 *   FAKE_LOGIN_MARK  授权码正确时创建这个文件（假智能体据此认为已登录）
 *   FAKE_LOGIN_NO_URL=1  不输出链接直接失败（测生成不了链接的情况）
 * 正确的授权码固定为 GOOD-CODE-1234567890#state。
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

if (process.env.FAKE_LOGIN_LOG)
  appendFileSync(
    process.env.FAKE_LOGIN_LOG,
    `${JSON.stringify({ args: process.argv.slice(2), browser: process.env.BROWSER ?? null, noBrowser: process.env.NO_BROWSER ?? null })}\n`,
  );
if (process.env.FAKE_LOGIN_NO_URL === "1") {
  process.stdout.write("Login failed: network unreachable\n");
  process.exit(1);
}
process.stdout.write("Opening browser to sign in\u2026\n");
process.stdout.write(
  "If the browser didn't open, visit: \u001b]8;;https://claude.example/oauth/authorize?code=true&state=SECRET-STATE\u0007https://claude.example/oauth/authorize?code=true&state=SECRET-STATE\u001b]8;;\u0007\n",
);
process.stdout.write("Paste code here if prompted > ");
const rl = createInterface({ input: process.stdin });
rl.once("line", (line) => {
  if (line.trim() === "GOOD-CODE-1234567890#state") {
    if (process.env.FAKE_LOGIN_MARK) writeFileSync(process.env.FAKE_LOGIN_MARK, "ok");
    process.stdout.write("\nLogin successful.\n");
    process.exit(0);
  }
  process.stdout.write("\nLogin failed: invalid authorization code\n");
  process.exit(1);
});
