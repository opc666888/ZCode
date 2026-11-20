import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acpAgentsConfigPath,
  builtinClaudeAgent,
  loadAcpAgents,
  parseAcpAgentsConfig,
  readAcpAgentsConfig,
  resolveBuiltinClaudeEntry,
} from "../src/config.js";
import { makeTempDir, removeDir } from "./helpers.js";

describe("acp-agents.json 读取", () => {
  let base: string;
  let savedBuiltin: string | undefined;
  beforeEach(async () => {
    base = await makeTempDir("config");
    // 这一组只测用户配置文件本身；内置默认智能体另有一组用例。
    savedBuiltin = process.env.ZCODE_ACP_BUILTIN;
    process.env.ZCODE_ACP_BUILTIN = "0";
  });
  afterEach(async () => {
    if (savedBuiltin === undefined) delete process.env.ZCODE_ACP_BUILTIN;
    else process.env.ZCODE_ACP_BUILTIN = savedBuiltin;
    await removeDir(base);
  });

  async function writeConfig(text: string) {
    await mkdir(join(base, ".zcode"), { recursive: true });
    await writeFile(acpAgentsConfigPath(base), text);
  }

  it("文件不存在返回 []，且不算错误", () => {
    expect(loadAcpAgents(base)).toEqual([]);
    expect(readAcpAgentsConfig(base)).toMatchObject({ exists: false, agents: [], errors: [] });
  });

  it("空文件返回 []", async () => {
    await writeConfig("  \n");
    expect(readAcpAgentsConfig(base)).toMatchObject({ exists: true, agents: [], errors: [] });
  });

  it("合法配置按 §3 格式读出，name 缺省为 id，models 去重去空", async () => {
    await writeConfig(
      JSON.stringify({
        agents: [
          {
            id: "claude",
            name: "Claude Code",
            command: "/bin/node",
            args: ["a.js"],
            env: { CLAUDE_CONFIG_DIR: "/x" },
            models: ["default", "opus", "opus", " "],
          },
          { id: "codex", command: "codex-acp" },
        ],
      }),
    );
    expect(loadAcpAgents(base)).toEqual([
      {
        id: "claude",
        name: "Claude Code",
        command: "/bin/node",
        args: ["a.js"],
        env: { CLAUDE_CONFIG_DIR: "/x" },
        models: ["default", "opus"],
      },
      { id: "codex", name: "codex", command: "codex-acp" },
    ]);
  });

  it("非法 JSON：返回 [] 并给出可读错误，不抛出", async () => {
    await writeConfig("{ agents: [");
    const result = readAcpAgentsConfig(base);
    expect(result.agents).toEqual([]);
    expect(result.errors[0]).toContain("不是合法 JSON");
    expect(() => loadAcpAgents(base)).not.toThrow();
  });

  it("顶层结构错误给出提示", () => {
    expect(parseAcpAgentsConfig("[]").errors[0]).toContain("顶层");
    expect(parseAcpAgentsConfig('{"agents": {}}').errors[0]).toContain("顶层");
  });

  it("坏条目只跳过该条，错误信息不含 env 的值", () => {
    const result = parseAcpAgentsConfig(
      JSON.stringify({
        agents: [
          "nope",
          { id: "bad id!", command: "x" },
          { id: "nocmd" },
          { id: "badargs", command: "x", args: [1] },
          { id: "badenv", command: "x", env: { TOKEN: 12345, OTHER: "super-secret-value" } },
          { id: "ok", command: "x", models: "opus" },
          { id: "ok", command: "y" },
        ],
      }),
    );
    expect(result.agents).toEqual([{ id: "ok", name: "ok", command: "x" }]);
    expect(result.errors).toHaveLength(7);
    expect(result.errors.join("\n")).not.toContain("super-secret-value");
    expect(result.errors.join("\n")).toContain("重复");
  });

  it("路径不可读（是目录）时返回错误而不是抛出", async () => {
    await mkdir(acpAgentsConfigPath(base), { recursive: true });
    const result = readAcpAgentsConfig(base);
    expect(result.agents).toEqual([]);
    expect(result.errors[0]).toContain("无法读取");
  });
});

describe("内置默认 Claude Code（装上就能用）", () => {
  let base: string;
  beforeEach(async () => {
    base = await makeTempDir("builtin");
  });
  afterEach(async () => {
    await removeDir(base);
  });

  const dataEntry = (dir: string) =>
    join(dir, ".zcode", "acp-agents", "claude", "node_modules", "@agentclientprotocol", "claude-agent-acp", "dist", "index.js");
  const probe = (found: string[], env: NodeJS.ProcessEnv = {}) => ({
    env,
    platform: "darwin" as const,
    home: "/Users/alice",
    execPath: "/app/node",
    exists: (path: string) => found.includes(path),
  });

  it("入口优先级：环境变量 > 数据目录 > 本机 Zed 已装的；都没有就不提供", () => {
    const zed =
      "/Users/alice/Library/Application Support/Zed/external_agents/registry/npx/claude-acp/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js";
    const all = ["/bundled/index.js", dataEntry(base), zed];
    expect(resolveBuiltinClaudeEntry(base, probe(all, { ZCODE_ACP_CLAUDE_ENTRY: "/bundled/index.js" }))).toBe("/bundled/index.js");
    expect(resolveBuiltinClaudeEntry(base, probe(all))).toBe(dataEntry(base));
    expect(resolveBuiltinClaudeEntry(base, probe([zed]))).toBe(zed);
    expect(resolveBuiltinClaudeEntry(base, probe([]))).toBeUndefined();
    expect(builtinClaudeAgent(base, probe([]))).toBeUndefined();
  });

  it("Windows 找 %LOCALAPPDATA%\\Zed 下的适配器", () => {
    const win = join("C:\\Users\\a\\AppData\\Local", "Zed", "external_agents", "registry", "npx", "claude-acp", "node_modules", "@agentclientprotocol", "claude-agent-acp", "dist", "index.js");
    expect(
      resolveBuiltinClaudeEntry(base, {
        env: { LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" },
        platform: "win32",
        home: "C:\\Users\\a",
        exists: (path) => path === win,
      }),
    ).toBe(win);
  });

  it("没有任何用户配置时自动提供 Claude Code，带模型列表；用当前运行时以 Node 模式启动", () => {
    const result = readAcpAgentsConfig(base, probe([dataEntry(base)]));
    expect(result).toMatchObject({ exists: false, builtin: true, errors: [] });
    expect(result.agents).toEqual([
      {
        id: "claude",
        name: "Claude Code",
        command: "/app/node",
        args: [dataEntry(base)],
        env: { ELECTRON_RUN_AS_NODE: "1" },
        models: ["default", "opus", "sonnet", "haiku"],
      },
    ]);
  });

  it("ZCODE_ACP_AGENT_HOME 把内置智能体的 HOME 指回真实家目录（宿主隔离 HOME 时钥匙串才找得到登录）", () => {
    const result = readAcpAgentsConfig(base, probe([dataEntry(base)], { ZCODE_ACP_AGENT_HOME: "/Users/real" }));
    expect(result.agents[0]?.env).toEqual({ ELECTRON_RUN_AS_NODE: "1", HOME: "/Users/real" });
  });

  it("用户自己配了智能体就不再追加内置项；ZCODE_ACP_BUILTIN=0 可以整个关掉", async () => {
    await mkdir(join(base, ".zcode"), { recursive: true });
    await writeFile(acpAgentsConfigPath(base), JSON.stringify({ agents: [{ id: "mine", command: "/x/launcher" }] }));
    const mine = readAcpAgentsConfig(base, probe([dataEntry(base)]));
    expect(mine.agents.map((agent) => agent.id)).toEqual(["mine"]);
    expect(mine.builtin).toBeUndefined();
    await writeFile(acpAgentsConfigPath(base), "");
    expect(readAcpAgentsConfig(base, probe([dataEntry(base)], { ZCODE_ACP_BUILTIN: "0" })).agents).toEqual([]);
  });
});
