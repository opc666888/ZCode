import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  NODE_REPL_PROXY_CONTEXT_ENV,
  NODE_REPL_PROXY_TARGET_ENV,
  REQUEST_CONTEXT_META_KEY,
  ensureNodeReplProxyScript,
} from "../src/acp-bridge/node-repl-meta-proxy.js";
import { convertMcpServers } from "../src/acp-bridge/session-resources.js";

/** 假宿主：原样回显收到的每一行。 */
const ECHO = `process.stdin.on("data",(c)=>process.stdout.write(c));process.stdin.on("end",()=>process.exit(0));`;

function runProxy(lines: unknown[], context: Record<string, unknown>): Promise<unknown[]> {
  const script = ensureNodeReplProxyScript(mkdtempSync(join(tmpdir(), "nrp-")));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      env: {
        ...process.env,
        [NODE_REPL_PROXY_TARGET_ENV]: JSON.stringify({ command: process.execPath, args: ["-e", ECHO] }),
        [NODE_REPL_PROXY_CONTEXT_ENV]: JSON.stringify(context),
      },
      stdio: ["pipe", "pipe", "inherit"],
    });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.on("error", reject);
    child.on("exit", () => resolve(out.trim().split("\n").map((l) => JSON.parse(l))));
    for (const l of lines) child.stdin.write(`${JSON.stringify(l)}\n`);
    child.stdin.end();
  });
}

describe("node_repl 会话身份中继", () => {
  it("tools/call 没带身份的补上；已带身份的、别的方法原样转发", async () => {
    const ctx = { session_id: "s-1", workspace_path: "/proj", workspace_key: "/proj" };
    const out = (await runProxy(
      [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "js", arguments: { code: "1" }, _meta: { progressToken: 7 } } },
        { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "js", _meta: { [REQUEST_CONTEXT_META_KEY]: { session_id: "own" } } } },
      ],
      ctx,
    )) as { id: number; params: { _meta?: Record<string, unknown> } }[];
    expect(out).toHaveLength(3);
    expect(out[0]!.params._meta).toBeUndefined();
    expect(out[1]!.params._meta).toEqual({ progressToken: 7, [REQUEST_CONTEXT_META_KEY]: ctx });
    expect(out[2]!.params._meta).toEqual({ [REQUEST_CONTEXT_META_KEY]: { session_id: "own" } });
  });

  it("node_repl 经中继启动：原命令放进环境变量，其他 MCP 不动", () => {
    const out = convertMcpServers(
      {
        node_repl: { type: "stdio", command: "/x/Helper", args: ["repl.js"], env: { ELECTRON_RUN_AS_NODE: "1" } },
        other: { type: "stdio", command: "/x/o", args: ["a"] },
      },
      "/proj",
      new Set(),
      "sess-9",
      "/state/node-repl-meta-proxy.cjs",
    ) as { command: string; args: string[]; env: { name: string; value: string }[] }[];
    expect(out[0]!.command).toBe("/x/Helper");
    expect(out[0]!.args).toEqual(["/state/node-repl-meta-proxy.cjs"]);
    const env = Object.fromEntries(out[0]!.env.map((e) => [e.name, e.value]));
    expect(JSON.parse(env[NODE_REPL_PROXY_TARGET_ENV]!)).toEqual({ command: "/x/Helper", args: ["repl.js"] });
    expect(JSON.parse(env[NODE_REPL_PROXY_CONTEXT_ENV]!).session_id).toBe("sess-9");
    expect(env.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(out[1]!.args).toEqual(["a"]);
  });
});
