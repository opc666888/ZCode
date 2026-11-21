/**
 * 测试辅助：临时目录放在包内 test/.tmp（已被 apps/zcode-cli/.gitignore 的 `.tmp/` 忽略），
 * 不写系统 /tmp；可用 ACP_ENGINE_TEST_TMPDIR 覆盖。
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export const FAKE_AGENT = join(here, "fake-agent.mjs");

export async function makeTempDir(prefix: string): Promise<string> {
  const base = process.env.ACP_ENGINE_TEST_TMPDIR ?? join(here, ".tmp");
  await mkdir(base, { recursive: true });
  return mkdtemp(join(base, `${prefix}-`));
}

export async function removeDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}
