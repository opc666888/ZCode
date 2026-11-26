import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  OPEN_COMPUTER_USE_INTEGRITY,
  OPEN_COMPUTER_USE_VERSION,
  openComputerUseTarballUrl,
  resolveOpenComputerUseAsset,
  stageOpenComputerUse,
} from "../scripts/open-computer-use-assets.mjs";

const roots: string[] = [];
// 测试目录放在仓库自己的缓存目录下，跑完即删（不写系统临时目录）。
const testCacheRoot = join(__dirname, "..", "node_modules", ".cache");

async function makeRoot(): Promise<string> {
  await mkdir(testCacheRoot, { recursive: true });
  const root = await mkdtemp(join(testCacheRoot, "ocu-assets-test-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

/** 按 npm registry tarball 布局（顶层 package/）打一个最小 open-computer-use 包。 */
async function createFakeTarball(root: string) {
  const packageRoot = join(root, "source", "package");
  const macOs = join(packageRoot, "dist", "Open Computer Use.app", "Contents", "MacOS");
  await mkdir(macOs, { recursive: true });
  await writeFile(join(macOs, "OpenComputerUse"), "mac-binary", { mode: 0o755 });
  for (const arch of ["amd64", "arm64"]) {
    const dir = join(packageRoot, "dist", "windows", arch);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "open-computer-use.exe"), `win-${arch}`, { mode: 0o755 });
  }
  const tarballPath = join(root, "ocu.tgz");
  execFileSync("tar", ["-czf", tarballPath, "-C", join(root, "source"), "package"]);
  const integrity = `sha512-${createHash("sha512")
    .update(await readFile(tarballPath))
    .digest("base64")}`;
  return { integrity, tarballPath };
}

async function makeStagedPlugin(glmDir: string) {
  const manifestDir = join(glmDir, "packages", "desktop-control-plugin", ".zcode-plugin");
  await mkdir(manifestDir, { recursive: true });
  await writeFile(join(manifestDir, "plugin.json"), '{"name":"desktop-control"}');
}

describe("open-computer-use constants", () => {
  it("pins an exact version and its registry sha512", () => {
    expect(OPEN_COMPUTER_USE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(OPEN_COMPUTER_USE_INTEGRITY).toMatch(/^sha512-[A-Za-z0-9+/]+=*$/);
    expect(openComputerUseTarballUrl("1.1.6")).toBe(
      "https://registry.npmjs.org/open-computer-use/-/open-computer-use-1.1.6.tgz",
    );
  });

  it("maps only Mac and Windows targets", () => {
    expect(resolveOpenComputerUseAsset("darwin-arm64")?.target).toBe("Open Computer Use.app");
    expect(resolveOpenComputerUseAsset("darwin-x64")?.target).toBe("Open Computer Use.app");
    expect(resolveOpenComputerUseAsset("win32-x64")?.source).toEqual([
      "dist",
      "windows",
      "amd64",
      "open-computer-use.exe",
    ]);
    expect(resolveOpenComputerUseAsset("linux-x64")).toBeNull();
  });
});

describe("stageOpenComputerUse", () => {
  it("stages the signed Mac app bundle with its executable bit", async () => {
    const root = await makeRoot();
    const fake = await createFakeTarball(root);
    const glmDir = join(root, "glm");
    await makeStagedPlugin(glmDir);
    const download = vi.fn(async (_url: string, destination: string) => {
      await copyFile(fake.tarballPath, destination);
    });

    const executable = await stageOpenComputerUse({
      cacheDir: join(root, "cache"),
      download,
      glmDir,
      integrity: fake.integrity,
      platformKey: "darwin-arm64",
      version: "9.9.9",
    });

    expect(executable).toBe(
      join(
        glmDir,
        "packages",
        "desktop-control-plugin",
        "dist",
        "ocu",
        "Open Computer Use.app",
        "Contents",
        "MacOS",
        "OpenComputerUse",
      ),
    );
    expect(statSync(executable as string).mode & 0o111).not.toBe(0);
    expect(download).toHaveBeenCalledWith(
      "https://registry.npmjs.org/open-computer-use/-/open-computer-use-9.9.9.tgz",
      expect.any(String),
    );
    // 解包目录用完即删，缓存里只留校验过的 tarball。
    const cacheEntries = execFileSync("ls", [join(root, "cache")]).toString().trim().split("\n");
    expect(cacheEntries).toEqual(["open-computer-use-9.9.9.tgz"]);
  });

  it("stages only the matching Windows exe", async () => {
    const root = await makeRoot();
    const fake = await createFakeTarball(root);
    const glmDir = join(root, "glm");
    await makeStagedPlugin(glmDir);

    const executable = await stageOpenComputerUse({
      cacheDir: join(root, "cache"),
      download: async (_url: string, destination: string) => copyFile(fake.tarballPath, destination),
      glmDir,
      integrity: fake.integrity,
      platformKey: "win32-x64",
    });

    expect(await readFile(executable as string, "utf8")).toBe("win-amd64");
    const ocuDir = join(glmDir, "packages", "desktop-control-plugin", "dist", "ocu");
    expect(existsSync(join(ocuDir, "Open Computer Use.app"))).toBe(false);
  });

  it("rejects a tarball whose sha512 does not match", async () => {
    const root = await makeRoot();
    const fake = await createFakeTarball(root);
    const glmDir = join(root, "glm");
    await makeStagedPlugin(glmDir);

    await expect(
      stageOpenComputerUse({
        cacheDir: join(root, "cache"),
        download: async (_url: string, destination: string) =>
          copyFile(fake.tarballPath, destination),
        glmDir,
        integrity: OPEN_COMPUTER_USE_INTEGRITY,
        platformKey: "darwin-x64",
        version: "9.9.9",
      }),
    ).rejects.toThrow(/sha512 mismatch/);
  });

  it("skips unsupported platforms without touching the plugin", async () => {
    const root = await makeRoot();
    const result = await stageOpenComputerUse({
      cacheDir: join(root, "cache"),
      download: vi.fn(),
      glmDir: join(root, "glm"),
      platformKey: "linux-x64",
    });
    expect(result).toBeNull();
  });
});
