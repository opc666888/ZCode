import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { redactSecrets } from "../src/agent-process.js";
import {
  readWorkspaceTextFile,
  resolveInsideWorkspace,
  writeWorkspaceTextFile,
} from "../src/client-fs.js";
import { SessionStore } from "../src/session-store.js";
import { makeTempDir, removeDir } from "./helpers.js";

describe("client-fs", () => {
  let base: string;
  let cwd: string;
  beforeEach(async () => {
    base = await makeTempDir("fs");
    cwd = join(base, "work");
    await mkdir(cwd, { recursive: true });
    await writeFile(join(cwd, "a.txt"), "1\n2\n3\n4");
    await writeFile(join(base, "outside.txt"), "secret");
  });
  afterEach(async () => {
    await removeDir(base);
  });

  it("读：支持 line/limit；写：自动建目录", async () => {
    expect(await readWorkspaceTextFile(cwd, { path: join(cwd, "a.txt") })).toEqual({
      content: "1\n2\n3\n4",
    });
    expect(
      await readWorkspaceTextFile(cwd, { path: join(cwd, "a.txt"), line: 2, limit: 2 }),
    ).toEqual({ content: "2\n3" });
    await writeWorkspaceTextFile(cwd, { path: join(cwd, "d/e/f.txt"), content: "x" });
    expect(await readFile(join(cwd, "d/e/f.txt"), "utf8")).toBe("x");
  });

  it("拒绝相对路径、.. 越界和符号链接越界", async () => {
    await expect(resolveInsideWorkspace(cwd, "a.txt")).rejects.toThrow("绝对路径");
    await expect(resolveInsideWorkspace(cwd, join(cwd, "..", "outside.txt"))).rejects.toThrow(
      "工作区内",
    );
    await symlink(base, join(cwd, "link"));
    await expect(
      readWorkspaceTextFile(cwd, { path: join(cwd, "link", "outside.txt") }),
    ).rejects.toThrow("工作区内");
    await expect(
      writeWorkspaceTextFile(cwd, { path: join(cwd, "link", "new.txt"), content: "x" }),
    ).rejects.toThrow("工作区内");
    await expect(
      writeWorkspaceTextFile(cwd, { path: join(cwd, "ok.txt"), content: 1 }),
    ).rejects.toThrow("content");
  });
});

describe("SessionStore", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTempDir("store");
  });
  afterEach(async () => {
    await removeDir(dir);
  });

  it("并发写入后文件完整、可被新实例读回；删除生效", async () => {
    const store = new SessionStore(join(dir, "state"), () => {});
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.set(`z${i}`, "a", `s${i}`)));
    const fresh = new SessionStore(join(dir, "state"), () => {});
    expect(await fresh.get("z7")).toMatchObject({ agentId: "a", acpSessionId: "s7" });
    await fresh.delete("z7");
    expect(await new SessionStore(join(dir, "state"), () => {}).get("z7")).toBeUndefined();
  });

  it("坏文件按空映射处理并记录日志", async () => {
    await mkdir(join(dir, "state"), { recursive: true });
    await writeFile(join(dir, "state", "sessions.json"), "{broken");
    const logs: string[] = [];
    const store = new SessionStore(join(dir, "state"), (m) => logs.push(m));
    expect(await store.get("x")).toBeUndefined();
    expect(logs[0]).toContain("读取失败");
  });
});

describe("redactSecrets", () => {
  it("遮盖常见令牌样式", () => {
    const out = redactSecrets(
      "Authorization: Bearer abc.def-123 token=xyz sk-ant-1234567890abcdef " + "A".repeat(48),
    );
    expect(out).not.toContain("abc.def-123");
    expect(out).not.toContain("xyz");
    expect(out).not.toContain("sk-ant-1234567890abcdef");
    expect(out).not.toContain("A".repeat(48));
  });
});
