// Claude 360 Code「电脑操作」插件（desktop-control）的原生程序：Open Computer Use（MIT，
// https://github.com/iFurySt/open-computer-use）。按固定版本 + registry sha512 下载 npm tarball 并缓存，
// 只把目标平台需要的那一份放进 <glmDir>/packages/desktop-control-plugin/dist/ocu/：
// - darwin-*：Open Computer Use.app（官方 Developer ID 签名 + 公证的通用二进制，原样拷贝不改，
//   glm 目录在 electron-builder signIgnore 里，不会被重签，权限弹窗显示的仍是它自己的签名）
// - win32-x64 / win32-arm64：对应架构的 open-computer-use.exe
// 插件启动器 scripts/launch.mjs 按同一布局找程序。升级版本时同步改版本号与摘要。
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, cp, mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { downloadPrebuiltArchive } from "../../../scripts/prebuilt-binary-download.mjs";
import { extractPrebuiltArchive } from "../../../scripts/prebuilt-binary-extract.mjs";

export const OPEN_COMPUTER_USE_VERSION = "1.1.6";
export const OPEN_COMPUTER_USE_INTEGRITY =
  "sha512-5pQI14WrEl9l3E1xl1rZwCx9Ub1f2zj9kbcAiwl+fjgsuI6xGY4NtQNuM45FKjBTL4qALDyaH5pkKL1aqthtlg==";
export const DESKTOP_CONTROL_PLUGIN_STAGED_PATH = "packages/desktop-control-plugin";
const MAC_APP_NAME = "Open Computer Use.app";

export function openComputerUseTarballUrl(version) {
  return `https://registry.npmjs.org/open-computer-use/-/open-computer-use-${version}.tgz`;
}

/** 目标平台 → [tarball 内相对 package/ 的源路径, dist/ocu 下的目标名, 启动器要找的可执行文件]。 */
export function resolveOpenComputerUseAsset(platformKey) {
  if (platformKey === "darwin-arm64" || platformKey === "darwin-x64") {
    return {
      source: ["dist", MAC_APP_NAME],
      target: MAC_APP_NAME,
      executable: [MAC_APP_NAME, "Contents", "MacOS", "OpenComputerUse"],
    };
  }
  if (platformKey === "win32-x64" || platformKey === "win32-arm64") {
    const arch = platformKey === "win32-x64" ? "amd64" : "arm64";
    return {
      source: ["dist", "windows", arch, "open-computer-use.exe"],
      target: "open-computer-use.exe",
      executable: ["open-computer-use.exe"],
    };
  }
  return null;
}

/**
 * 插件目录已经 stage 好之后调用。不支持的平台（如 Linux）直接跳过：插件仍在，启动器会如实报「不支持这个系统」。
 * download / extract 可注入，测试无需网络。
 */
export async function stageOpenComputerUse({
  cacheDir,
  download = downloadPrebuiltArchive,
  extract = extractPrebuiltArchive,
  glmDir,
  integrity = OPEN_COMPUTER_USE_INTEGRITY,
  platformKey,
  version = OPEN_COMPUTER_USE_VERSION,
}) {
  const asset = resolveOpenComputerUseAsset(platformKey);
  if (!asset) return null;
  const pluginRoot = join(glmDir, ...DESKTOP_CONTROL_PLUGIN_STAGED_PATH.split("/"));
  await access(join(pluginRoot, ".zcode-plugin", "plugin.json"));

  const tarballPath = await ensureVerifiedTarball({ cacheDir, download, integrity, version });
  // 解包目录放在缓存目录下（不用系统临时目录），用完即删。
  const workDir = join(cacheDir, `extract-${process.pid}-${randomUUID()}`);
  await mkdir(workDir, { recursive: true });
  try {
    extract({ archiveExt: "tgz", archivePath: tarballPath, cwd: workDir, extractDir: workDir });
    const sourcePath = join(workDir, "package", ...asset.source);
    await access(sourcePath);
    const ocuRoot = join(pluginRoot, "dist", "ocu");
    await rm(ocuRoot, { force: true, recursive: true });
    await mkdir(ocuRoot, { recursive: true });
    const targetPath = join(ocuRoot, asset.target);
    await cp(sourcePath, targetPath, { recursive: true, verbatimSymlinks: true });
    const executablePath = join(ocuRoot, ...asset.executable);
    await access(executablePath);
    return executablePath;
  } finally {
    await rm(workDir, { force: true, recursive: true });
  }
}

async function ensureVerifiedTarball({ cacheDir, download, integrity, version }) {
  const tarballPath = join(cacheDir, `open-computer-use-${version}.tgz`);
  if (await isTarballValid(tarballPath, integrity)) return tarballPath;

  await mkdir(cacheDir, { recursive: true });
  const temporaryPath = `${tarballPath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await download(openComputerUseTarballUrl(version), temporaryPath);
    if (!(await isTarballValid(temporaryPath, integrity))) {
      throw new Error(`[open-computer-use] sha512 mismatch for open-computer-use@${version}`);
    }
    await rename(temporaryPath, tarballPath);
    return tarballPath;
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function isTarballValid(tarballPath, integrity) {
  try {
    return (await sha512Integrity(tarballPath)) === integrity;
  } catch {
    return false;
  }
}

function sha512Integrity(path) {
  return new Promise((resolvePromise, rejectPromise) => {
    const hash = createHash("sha512");
    createReadStream(path)
      .on("error", rejectPromise)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolvePromise(`sha512-${hash.digest("base64")}`));
  });
}
