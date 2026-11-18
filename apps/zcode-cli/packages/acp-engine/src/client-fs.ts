/**
 * ACP 客户端文件能力（fs/read_text_file、fs/write_text_file），只允许访问会话 cwd 内的路径。
 *
 * 越界判断基于真实路径：目标（或其最近的已存在祖先）realpath 后必须落在 cwd 的 realpath 之内，
 * 防止通过符号链接或 `..` 跳出工作区。
 */
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

export class WorkspaceFsError extends Error {}

async function realpathOfNearestExisting(target: string): Promise<string> {
  let current = target;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = await realpath(current);
      return tail.length > 0 ? resolve(real, ...tail.reverse()) : real;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) return target;
      tail.push(basename(current));
      current = parent;
    }
  }
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/** 返回 cwd 内的绝对路径；越界或非绝对路径时抛 WorkspaceFsError。 */
export async function resolveInsideWorkspace(cwd: string, path: unknown): Promise<string> {
  if (typeof path !== "string" || !isAbsolute(path)) {
    throw new WorkspaceFsError("路径必须是绝对路径");
  }
  const target = resolve(path);
  const root = await realpath(cwd).catch(() => resolve(cwd));
  const realTarget = await realpathOfNearestExisting(target);
  if (!isInside(root, realTarget)) {
    throw new WorkspaceFsError("只允许访问当前工作区内的文件");
  }
  return target;
}

export async function readWorkspaceTextFile(
  cwd: string,
  params: { path?: unknown; line?: unknown; limit?: unknown },
): Promise<{ content: string }> {
  const file = await resolveInsideWorkspace(cwd, params.path);
  const text = await readFile(file, "utf8");
  const line =
    typeof params.line === "number" && params.line > 0 ? Math.floor(params.line) : undefined;
  const limit =
    typeof params.limit === "number" && params.limit > 0 ? Math.floor(params.limit) : undefined;
  if (line === undefined && limit === undefined) return { content: text };
  const lines = text.split("\n");
  const start = (line ?? 1) - 1;
  const end = limit === undefined ? lines.length : start + limit;
  return { content: lines.slice(start, end).join("\n") };
}

export async function writeWorkspaceTextFile(
  cwd: string,
  params: { path?: unknown; content?: unknown },
): Promise<Record<string, never>> {
  const file = await resolveInsideWorkspace(cwd, params.path);
  if (typeof params.content !== "string") throw new WorkspaceFsError("content 必须是字符串");
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, params.content, "utf8");
  return {};
}
