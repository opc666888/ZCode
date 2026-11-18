/**
 * zcodeSessionId → { agentId, acpSessionId } 映射，持久化在 `<stateDir>/sessions.json`。
 *
 * 唯一写入者：同一引擎实例内的 SessionStore。写入串行化（promise 链）并用「临时文件 + rename」
 * 原子替换，进程崩溃时不会留下半截 JSON。读坏文件时当作空映射（只是丢失可恢复性，不影响新会话）。
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface SessionMapping {
  agentId: string;
  acpSessionId: string;
  updatedAt: string;
}

interface SessionFile {
  version: 1;
  sessions: Record<string, SessionMapping>;
}

export class SessionStore {
  private readonly file: string;
  private cache: Map<string, SessionMapping> | undefined;
  private loading: Promise<Map<string, SessionMapping>> | undefined;
  private writeChain: Promise<void> = Promise.resolve();
  private seq = 0;

  constructor(
    private readonly stateDir: string,
    private readonly log: (msg: string) => void,
  ) {
    this.file = join(stateDir, "sessions.json");
  }

  private async load(): Promise<Map<string, SessionMapping>> {
    if (this.cache) return this.cache;
    this.loading ??= (async () => {
      const map = new Map<string, SessionMapping>();
      try {
        const data = JSON.parse(await readFile(this.file, "utf8")) as Partial<SessionFile>;
        for (const [key, value] of Object.entries(data.sessions ?? {})) {
          if (
            value &&
            typeof value.agentId === "string" &&
            typeof value.acpSessionId === "string"
          ) {
            map.set(key, {
              agentId: value.agentId,
              acpSessionId: value.acpSessionId,
              updatedAt: String(value.updatedAt ?? ""),
            });
          }
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT")
          this.log(
            `[acp-engine] sessions.json 读取失败，按空映射处理：${code ?? (error as Error).message}`,
          );
      }
      this.cache = map;
      return map;
    })();
    return this.loading;
  }

  async get(zcodeSessionId: string): Promise<SessionMapping | undefined> {
    return (await this.load()).get(zcodeSessionId);
  }

  async set(zcodeSessionId: string, agentId: string, acpSessionId: string): Promise<void> {
    const map = await this.load();
    map.set(zcodeSessionId, { agentId, acpSessionId, updatedAt: new Date().toISOString() });
    await this.persist();
  }

  async delete(zcodeSessionId: string): Promise<void> {
    const map = await this.load();
    if (map.delete(zcodeSessionId)) await this.persist();
  }

  private persist(): Promise<void> {
    const run = async () => {
      const map = await this.load();
      const body: SessionFile = { version: 1, sessions: Object.fromEntries(map) };
      await mkdir(this.stateDir, { recursive: true });
      const tmp = `${this.file}.${process.pid}.${++this.seq}.tmp`;
      await writeFile(tmp, `${JSON.stringify(body, null, 2)}\n`, "utf8");
      await rename(tmp, this.file);
    };
    const next = this.writeChain.then(run, run);
    this.writeChain = next.catch((error: unknown) => {
      this.log(`[acp-engine] sessions.json 写入失败：${(error as Error).message}`);
    });
    return next;
  }
}
