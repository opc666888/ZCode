import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  modelOptionsFromConfigOptions,
  presentModels,
  readCommandCache,
  readModelCache,
  writeCommandCache,
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

  it("默认固定叫「默认（推荐）」；其余用带版本号的名字；显示名重复时加上原值区分", () => {
    const shown = presentModels([
      { value: "default", name: "Default (recommended)", description: "Sonnet 5.5" },
      { value: "opus", name: "Opus 5.5" },
      { value: "claude-opus-5-5", name: "Opus 5.5" },
    ]);
    expect(shown.models).toEqual(["默认（推荐）", "Opus 5.5", "Opus 5.5（claude-opus-5-5）"]);
    expect(shown.modelValues["Opus 5.5（claude-opus-5-5）"]).toBe("claude-opus-5-5");
    expect(presentModels([{ value: "default", name: "Default" }]).models).toEqual(["默认（推荐）"]);
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
  it("斜杠命令缓存：去掉开头的 /、去重、丢掉不像命令名的；空清单也写（表示没有命令）", async () => {
    const base = await makeTempDir("cmds");
    const stateDir = join(base, ".zcode", "acp-bridge");
    writeCommandCache(stateDir, "claude", [
      { name: "/usage", description: "看用量" },
      { name: "usage", description: "重复" },
      { name: "context" },
      { name: "有 空格" },
      { name: 42 },
      "乱七八糟",
    ]);
    expect(readCommandCache(base, "claude")).toEqual([
      { name: "usage", description: "看用量" },
      { name: "context", description: "" },
    ]);
    writeCommandCache(stateDir, "claude", []);
    expect(readCommandCache(base, "claude")).toEqual([]);
    expect(readCommandCache(base, "none")).toEqual([]);
    await removeDir(base);
  });
});

describe("默认模型名固定（11-24：登录前后默认模型变了，名字不能跟着变）", () => {
  it("不管适配器说默认是哪个模型，显示名都是「默认（推荐）」；旧名字都认作默认", async () => {
    const { presentModels, isLegacyDefaultModelLabel, ACP_DEFAULT_MODEL_LABEL } = await import("../src/models.js");
    const before = presentModels([{ value: "default", name: "Default", description: "Sonnet 5.5" }]);
    const after = presentModels([{ value: "default", name: "Default", description: "Opus" }]);
    expect(before.models[0]).toBe(ACP_DEFAULT_MODEL_LABEL);
    expect(after.models[0]).toBe(before.models[0]);
    for (const old of ["默认", "默认（Opus）", "默认（Sonnet 5.5）", "默认（推荐）"]) expect(isLegacyDefaultModelLabel(old)).toBe(true);
    for (const other of ["Opus 5.5", "默认模型x", undefined]) expect(isLegacyDefaultModelLabel(other)).toBe(false);
  });
});
