import { describe, expect, it } from "vitest";
import { buildAgentEnv, proxyEnvKeyNames } from "../src/agent-process.js";

const who = () => ({ username: "alice", homedir: "/Users/alice", shell: "/bin/zsh" });

describe("buildAgentEnv", () => {
  it("缺 USER / LOGNAME / HOME / SHELL 时从系统账户补上（Claude Code 靠 USER 取钥匙串凭据）", () => {
    const env = buildAgentEnv({ PATH: "/usr/bin" }, undefined, who);
    expect(env).toMatchObject({ PATH: "/usr/bin", USER: "alice", LOGNAME: "alice", HOME: "/Users/alice", SHELL: "/bin/zsh" });
  });

  it("已有的值不动；agent.env 最后覆盖", () => {
    const env = buildAgentEnv({ USER: "bob", HOME: "/h/bob" }, { HOME: "/custom", CLAUDE_CONFIG_DIR: "/c" }, who);
    expect(env.USER).toBe("bob");
    expect(env.LOGNAME).toBe("alice");
    expect(env.HOME).toBe("/custom");
    expect(env.CLAUDE_CONFIG_DIR).toBe("/c");
  });

  it("取不到系统账户信息时不抛错，原样返回", () => {
    const env = buildAgentEnv({ A: "1" }, { B: "2" }, () => {
      throw new Error("no passwd entry");
    });
    expect(env).toEqual({ A: "1", B: "2" });
  });
  it("设置页的代理（ZCODE_HTTP_PROXY）补成标准变量；已有的标准变量不动；没配就不加", () => {
    const filled = buildAgentEnv({ ZCODE_HTTP_PROXY: "http://127.0.0.1:7890" }, undefined, who);
    expect(filled.HTTPS_PROXY).toBe("http://127.0.0.1:7890");
    expect(filled.http_proxy).toBe("http://127.0.0.1:7890");
    expect(filled.NO_PROXY).toBe("localhost,127.0.0.1,::1");
    const kept = buildAgentEnv({ ZCODE_HTTP_PROXY: "http://a:1", HTTPS_PROXY: "http://b:2", ZCODE_NO_PROXY: ".corp" }, undefined, who);
    expect(kept.HTTPS_PROXY).toBe("http://b:2");
    expect(kept.HTTP_PROXY).toBe("http://a:1");
    expect(kept.NO_PROXY).toBe(".corp");
    expect(proxyEnvKeyNames(kept)).toContain("HTTPS_PROXY");
    expect(proxyEnvKeyNames(buildAgentEnv({ PATH: "/usr/bin" }, undefined, who))).toEqual([]);
  });
});
