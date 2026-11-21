import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  createBuildTimeConfigDefines,
  resolveBuildPrivacyMode,
  resolveBuildTimeConfig,
} from "../build-time-config.mjs";

// 上游行为用例显式关闭 acp-bridge 隐私模式（默认开启）。
const UPSTREAM = { ZCODE_PRIVACY_MODE: "0" };

const dir = await mkdtemp(join(tmpdir(), "zcode-build-time-config-"));
after(() => rm(dir, { recursive: true, force: true }));

async function writeDefaults(name, content) {
  const path = join(dir, name);
  await writeFile(path, typeof content === "string" ? content : JSON.stringify(content));
  return path;
}

test("没有私有默认配置也没有环境变量时三项能力都关闭", async () => {
  const config = await resolveBuildTimeConfig(UPSTREAM, {
    defaultsPath: join(dir, "missing.json"),
  });
  assert.deepEqual(config, {
    armsRumEndpoint: "",
    telemetryReportEndpoint: "",
    autoUpdateEnabled: false,
    privacyMode: false,
  });
});

test("私有默认配置启用三项能力", async () => {
  const defaultsPath = await writeDefaults("defaults.json", {
    ZCODE_ARMS_RUM_ENDPOINT: " https://rum.example.com/x ",
    ZCODE_TELEMETRY_REPORT_ENDPOINT: "https://report.example.com/event",
    ZCODE_AUTO_UPDATE: "1",
  });
  assert.deepEqual(await resolveBuildTimeConfig(UPSTREAM, { defaultsPath }), {
    armsRumEndpoint: "https://rum.example.com/x",
    telemetryReportEndpoint: "https://report.example.com/event",
    autoUpdateEnabled: true,
    privacyMode: false,
  });
});

test("环境变量优先于私有默认配置，显式空字符串关闭单项能力", async () => {
  const defaultsPath = await writeDefaults("override.json", {
    ZCODE_ARMS_RUM_ENDPOINT: "https://rum.example.com/x",
    ZCODE_TELEMETRY_REPORT_ENDPOINT: "https://report.example.com/event",
    ZCODE_AUTO_UPDATE: "true",
  });
  const config = await resolveBuildTimeConfig(
    {
      ...UPSTREAM,
      ZCODE_ARMS_RUM_ENDPOINT: "",
      ZCODE_TELEMETRY_REPORT_ENDPOINT: "https://other.example.com/event",
      ZCODE_AUTO_UPDATE: "0",
    },
    { defaultsPath },
  );
  assert.deepEqual(config, {
    armsRumEndpoint: "",
    telemetryReportEndpoint: "https://other.example.com/event",
    autoUpdateEnabled: false,
    privacyMode: false,
  });
});

test("私有默认配置格式错误时直接报错，不静默关闭", async () => {
  const defaultsPath = await writeDefaults("broken.json", "[1]");
  await assert.rejects(resolveBuildTimeConfig(UPSTREAM, { defaultsPath }), /必须是 JSON 对象/);
});

test("define 以 JSON 字面量注入", () => {
  assert.deepEqual(
    createBuildTimeConfigDefines({
      armsRumEndpoint: "https://rum.example.com/x",
      telemetryReportEndpoint: "",
      autoUpdateEnabled: true,
      privacyMode: false,
    }),
    {
      __ZCODE_ARMS_RUM_ENDPOINT__: '"https://rum.example.com/x"',
      __ZCODE_TELEMETRY_REPORT_ENDPOINT__: '""',
      __ZCODE_AUTO_UPDATE_ENABLED__: "true",
      __ZCODE_PRIVACY_MODE__: "false",
    },
  );
});

test("acp-bridge 隐私模式默认开启，仅显式 0/false/off/no 关闭", () => {
  assert.equal(resolveBuildPrivacyMode({}), true);
  assert.equal(resolveBuildPrivacyMode({ ZCODE_PRIVACY_MODE: " " }), true);
  assert.equal(resolveBuildPrivacyMode({ ZCODE_PRIVACY_MODE: "1" }), true);
  for (const value of ["0", "false", "OFF", " no "]) {
    assert.equal(resolveBuildPrivacyMode({ ZCODE_PRIVACY_MODE: value }), false);
  }
});

test("acp-bridge 隐私模式构建显式置空三项能力并注入开启", async () => {
  const config = await resolveBuildTimeConfig({}, { defaultsPath: join(dir, "missing.json") });
  assert.deepEqual(config, {
    armsRumEndpoint: "",
    telemetryReportEndpoint: "",
    autoUpdateEnabled: false,
    privacyMode: true,
  });
  assert.equal(createBuildTimeConfigDefines(config).__ZCODE_PRIVACY_MODE__, "true");
  // 显式关闭自动更新不算注入。
  await resolveBuildTimeConfig(
    { ZCODE_AUTO_UPDATE: "0", ZCODE_ARMS_RUM_ENDPOINT: "" },
    { defaultsPath: join(dir, "missing.json") },
  );
});

test("acp-bridge 隐私模式构建存在 config/private 私有默认配置时失败", async () => {
  const defaultsPath = await writeDefaults("privacy-defaults.json", {
    ZCODE_ARMS_RUM_ENDPOINT: "https://rum.example.com/x",
  });
  await assert.rejects(
    resolveBuildTimeConfig({}, { defaultsPath }),
    /隐私模式构建不允许存在私有构建默认配置/,
  );
});

test("acp-bridge 隐私模式构建注入上报或自动更新变量时失败", async () => {
  const defaultsPath = join(dir, "missing.json");
  for (const env of [
    { ZCODE_ARMS_RUM_ENDPOINT: "https://rum.example.com/x" },
    { ZCODE_TELEMETRY_REPORT_ENDPOINT: "https://report.example.com/event" },
    { ZCODE_AUTO_UPDATE: "1" },
    { ZCODE_PACKAGED_AGENT_OTEL_ENDPOINT: "https://arms.example.com/otlp" },
  ]) {
    await assert.rejects(resolveBuildTimeConfig(env, { defaultsPath }), /隐私模式构建不允许注入/);
  }
});
