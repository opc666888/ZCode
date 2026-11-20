import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  modelOptionsFromConfigOptions,
  presentModels,
  readModelCache,
  writeModelCache,
} from "../src/models.js";
import { makeTempDir, removeDir } from "./helpers.js";

describe("模型清单（带版本号的显示名）", () => {
  let base: string;
  beforeEach(async () => {
    base = await makeTempDir("models");
  });
  afterEach(async () => {
    await removeDir(base);
  });

  const configOptions = [
    { id: "mode", options: [{ value: "default", name: "Manual" }] },
    {
      id: "model",
      options: [
        { value: "default", name: "Default (recommended)", description: "Sonnet 5.5" },
        { value: "opus", name: "Opus 5.5", description: "For complex work" },
        { value: "claude-fable-5-2", name: "Fable 5.2" },
        { value: "opus", name: "重复的值会被丢掉" },
        { value: 42, name: "坏条目" },
        "not-an-object",
      ],
    },
  ];

  it("只取 model 那一项，坏条目和重复值丢掉", () => {
    expect(modelOptionsFromConfigOptions(configOptions).map((o) => o.value)).toEqual([
      "default",
      "opus",
      "claude-fable-5-2",
    ]);
    expect(modelOptionsFromConfigOptions(undefined)).toEqual([]);
    expect(modelOptionsFromConfigOptions([{ id: "mode", options: [] }])).toEqual([]);
  });

  it("默认写明实际模型；其余用带版本号的名字；显示名重复时加上原值区分", () => {
    const shown = presentModels([
      { value: "default", name: "Default (recommended)", description: "Sonnet 5.5" },
      { value: "opus", name: "Opus 5.5" },
      { value: "claude-opus-5-5", name: "Opus 5.5" },
    ]);
    expect(shown.models).toEqual(["默认（Sonnet 5.5）", "Opus 5.5", "Opus 5.5（claude-opus-5-5）"]);
    expect(shown.modelValues["Opus 5.5（claude-opus-5-5）"]).toBe("claude-opus-5-5");
    expect(presentModels([{ value: "default", name: "Default" }]).models).toEqual(["默认"]);
  });

  it("缓存写到 <数据目录>/.zcode/acp-bridge/models-<id>.json，读回一致；空清单不写；读不到返回 []", async () => {
    const stateDir = join(base, ".zcode", "acp-bridge");
    const options = modelOptionsFromConfigOptions(configOptions);
    writeModelCache(stateDir, "claude", options);
    expect(JSON.parse(await readFile(join(stateDir, "models-claude.json"), "utf8")).options).toEqual(options);
    expect(readModelCache(base, "claude")).toEqual(options);
    writeModelCache(stateDir, "empty", []);
    expect(readModelCache(base, "empty")).toEqual([]);
    expect(readModelCache(base, "missing")).toEqual([]);
  });
});
