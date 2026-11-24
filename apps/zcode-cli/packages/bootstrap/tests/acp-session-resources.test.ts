import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  convertMcpServers,
  createHostSessionResources,
  materializeClaudePluginShells,
} from "../src/acp-bridge/session-resources.js";
import type { McpServerConfig, PluginMetadata, SkillRoot } from "@zcode/contracts";

const plugin = (id: string, name: string, rootPath: string, enabled = true) =>
  ({ id, name, rootPath, enabled, version: "1.0.0", description: name }) as unknown as PluginMetadata;

describe("acp-bridge 插件能力交给 Claude", () => {
  it("MCP：stdio 不带 type、展开项目目录占位符；跳过禁用 / 未受信任 / 需智谱登录 / OAuth 的", () => {
    const servers: Record<string, McpServerConfig> = {
      "plugin:documents:documents": {
        type: "stdio",
        command: "/x/Helper",
        args: ["host", "${ZCODE_PROJECT_DIR}/a"],
        cwd: "${ZCODE_PROJECT_DIR}",
        env: { ELECTRON_RUN_AS_NODE: "1", ROOT: "${ZCODE_PROJECT_DIR}" },
      },
      node_repl: { type: "stdio", command: "/x/Helper", args: ["repl"], env: { ZCODE_CUA_PLUGIN_ROOT: "/p/cua" } },
      off: { type: "stdio", command: "x", enabled: false },
      untrusted: { type: "stdio", command: "x" },
      official: { type: "stdio", command: "x", auth: { type: "zcode_official", provider: "jwt_token" } },
      remote: { type: "http", url: "https://e.x/mcp", headers: { A: "b" } },
      oauthed: { type: "http", url: "https://o.x/mcp", oauth: { type: "client_credentials", clientId: "c" } as never },
    };
    const out = convertMcpServers(servers, "/proj", new Set(["untrusted"]));
    expect(out.map((s) => s.name)).toEqual(["plugin_documents_documents", "node_repl", "remote"]);
    const doc = out[0] as { args: string[]; env: { name: string; value: string }[] };
    expect("type" in out[0]!).toBe(false);
    expect(doc.args).toEqual(["host", "/proj/a"]);
    expect(doc.env).toContainEqual({ name: "ROOT", value: "/proj" });
    expect(doc.env).toContainEqual({ name: "ZCODE_WORKSPACE_ROOT", value: "/proj" });
    expect(out[2]).toEqual({ type: "http", name: "remote", url: "https://e.x/mcp", headers: [{ name: "A", value: "b" }] });
  });

  it("技能：给启用插件生成 Claude 插件外壳，逐个技能软链；禁用的和 ZCode 自用的跳过", () => {
    const root = mkdtempSync(join(tmpdir(), "acp-res-"));
    const skills = join(root, "docs-plugin", "skills");
    mkdirSync(join(skills, "docx"), { recursive: true });
    writeFileSync(join(skills, "docx", "SKILL.md"), "---\nname: docx\n---\n");
    mkdirSync(join(skills, "not-a-skill"), { recursive: true });
    const single = join(root, "cua", "skills", "computer-use");
    mkdirSync(single, { recursive: true });
    writeFileSync(join(single, "SKILL.md"), "x");
    const plugins = [
      plugin("documents@o", "documents", join(root, "docs-plugin")),
      plugin("computer-use@o", "computer-use", join(root, "cua")),
      plugin("off@o", "off", root, false),
      plugin("zcode-guide@o", "zcode-guide", root),
    ];
    const roots: SkillRoot[] = [
      { path: skills, pluginId: "documents@o", scope: "user", source: "plugin", priority: 1 } as SkillRoot,
      { path: single, pluginId: "computer-use@o", scope: "user", source: "plugin", priority: 1 } as SkillRoot,
      { path: skills, pluginId: "off@o", scope: "user", source: "plugin", priority: 1 } as SkillRoot,
      { path: skills, pluginId: "zcode-guide@o", scope: "user", source: "plugin", priority: 1 } as SkillRoot,
    ];
    const state = join(root, "state");
    const dirs = materializeClaudePluginShells(plugins, roots, state);
    expect(dirs).toEqual([join(state, "claude-plugins", "documents"), join(state, "claude-plugins", "computer-use")]);
    const manifest = JSON.parse(readFileSync(join(dirs[0]!, ".claude-plugin", "plugin.json"), "utf8"));
    expect(manifest.name).toBe("documents");
    expect(readlinkSync(join(dirs[0]!, "skills", "docx"))).toBe(join(skills, "docx"));
    expect(existsSync(join(dirs[0]!, "skills", "not-a-skill"))).toBe(false);
    expect(readlinkSync(join(dirs[1]!, "skills", "computer-use"))).toBe(single);
    // 重复生成不报错（会话每次建 app 都会调）
    expect(materializeClaudePluginShells(plugins, roots, state)).toEqual(dirs);
    const res = createHostSessionResources({ mcpServers: {}, plugins, skillRoots: roots, stateDir: state });
    expect(res.forCwd("/p")).toEqual({ mcpServers: [], claudePluginDirs: dirs });
  });

  it("node_repl 拿到宿主给的会话身份兜底（电脑操作 / 浏览器操作要用），其他 MCP 不加", () => {
    const servers: Record<string, McpServerConfig> = {
      node_repl: { type: "stdio", command: "/x/Helper", env: { A: "1" } },
      other: { type: "stdio", command: "/y" },
    };
    const out = convertMcpServers(servers, "/proj", new Set(), "sess_1") as { name: string; env: { name: string; value: string }[] }[];
    const ctx = out[0]!.env.find((e) => e.name === "ZCODE_NODE_REPL_FALLBACK_CONTEXT");
    expect(JSON.parse(ctx!.value)).toEqual({ session_id: "sess_1", workspace_path: "/proj", workspace_key: "/proj" });
    expect(out[1]!.env.some((e) => e.name === "ZCODE_NODE_REPL_FALLBACK_CONTEXT")).toBe(false);
    expect(convertMcpServers(servers, "/proj")[0]).not.toHaveProperty("env.ZCODE_NODE_REPL_FALLBACK_CONTEXT");
  });
});
