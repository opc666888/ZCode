import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acpAgentsConfigPath,
  loadAcpAgents,
  parseAcpAgentsConfig,
  readAcpAgentsConfig,
} from "../src/config.js";
import { makeTempDir, removeDir } from "./helpers.js";

describe("acp-agents.json 读取", () => {
  let base: string;
  beforeEach(async () => {
    base = await makeTempDir("config");
  });
  afterEach(async () => {
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
