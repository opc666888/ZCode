// acp-bridge 隐私模式（docs/acp-bridge/PRIVACY.md）的出网守卫取样。App 业务单测已退役
// （docs/testing/unit-test-quality.md）；这里按「守隐私或安全边界的定向取样」例外处理：
// 使用 node:test，不进入工程 Vitest 清单和 pre-push。
// pnpm --filter @zcode/desktop test:privacy-mode
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { PRIVACY_MODE_ENV, isPrivacyMode } from "@zcode/shared/privacy-mode";

const FAKE_DEVICE_MID = "00000000-0000-4000-8000-000000000001";
// 临时目录跟随 TMPDIR（调用方负责把它指到工作区内的运行目录）。
const tempRoot = resolve(process.env.TMPDIR ?? process.cwd());
let dataBaseDir = "";

// 任何一次真实请求都算守卫失效。
const forbiddenApiClient = {
  request: async (input: unknown): Promise<Response> => {
    throw new Error(`privacy guard leaked a request: ${String(input)}`);
  },
} as unknown as import("@zcode/shared").ApiClient;

before(async () => {
  dataBaseDir = await mkdtemp(join(tempRoot, "zcode-privacy-mode-"));
  await mkdir(join(dataBaseDir, ".zcode", "v2"), { recursive: true });
  await writeFile(
    join(dataBaseDir, ".zcode", "v2", "telemetry-state.json"),
    JSON.stringify({ deviceMid: FAKE_DEVICE_MID }),
  );
  // services/paths.ts 在模块加载时读取该变量，必须先设置再动态导入 services 模块。
  process.env.ZCODE_DATA_BASE_DIR = dataBaseDir;
});

after(() => rm(dataBaseDir, { recursive: true, force: true }));

beforeEach(() => {
  delete process.env[PRIVACY_MODE_ENV];
});

test("isPrivacyMode 默认开启，仅显式 0/false/off/no 关闭", () => {
  assert.equal(isPrivacyMode({}), true);
  assert.equal(isPrivacyMode({ [PRIVACY_MODE_ENV]: "" }), true);
  assert.equal(isPrivacyMode({ [PRIVACY_MODE_ENV]: "1" }), true);
  assert.equal(isPrivacyMode({ [PRIVACY_MODE_ENV]: "on" }), true);
  for (const value of ["0", "false", "OFF", " no "]) {
    assert.equal(isPrivacyMode({ [PRIVACY_MODE_ENV]: value }), false, value);
  }
  assert.equal(isPrivacyMode(), true);
  process.env[PRIVACY_MODE_ENV] = "0";
  assert.equal(isPrivacyMode(), false);
});

test("未登录 z.ai 时不发送 X-Device-Mid；已登录或关闭隐私模式时照常发送", async () => {
  const { buildZCodeSourceHeaders } = await import("../../services/src/providers/sourceHeaders.js");
  assert.equal(buildZCodeSourceHeaders({})["X-Device-Mid"], undefined);
  assert.equal(buildZCodeSourceHeaders({ loggedIn: true })["X-Device-Mid"], FAKE_DEVICE_MID);
  process.env[PRIVACY_MODE_ENV] = "0";
  assert.equal(buildZCodeSourceHeaders({})["X-Device-Mid"], FAKE_DEVICE_MID);
});

test("营销弹窗查询与上报在隐私模式下不出网", async () => {
  const { createMarketingTouchService } =
    await import("../../services/src/marketing-touch/marketingTouchService.js");
  const service = createMarketingTouchService({
    apiClient: forbiddenApiClient,
    getToken: async () => null,
    getDeviceMid: () => FAKE_DEVICE_MID,
    baseUrl: "https://zcode.invalid/",
    appVersion: "0.0.0",
  });
  const snapshot = await service.query({ locale: "zh-CN" });
  assert.deepEqual(snapshot.deliveries, []);
  await service.report({
    locale: "zh-CN",
    scope: snapshot.scope,
    campaignId: "campaign",
    actionType: "cancel",
  });
});

test("client/configs 与 client/scenes 在隐私模式下不出网并返回空配置", async () => {
  const { createClientConfigService } =
    await import("../../services/src/client-config/clientConfigService.js");
  const { createClientScenesService } =
    await import("../../services/src/client-scenes/clientScenesService.js");
  const configs = createClientConfigService({
    apiClient: forbiddenApiClient,
    resolveRequestContext: () => ({
      endpointOrigin: "https://zcode.invalid",
      appVersion: "0.0.0",
      platform: "darwin-arm64",
    }),
  });
  const snapshot = await configs.getSnapshot();
  assert.deepEqual(snapshot.uiPluginRecommendations, []);
  assert.equal(snapshot.zsrcUrl, null);
  const scenes = await createClientScenesService({ apiClient: forbiddenApiClient }).list();
  assert.deepEqual(scenes, { code: 0, msg: "", data: [] });
});

test("桌面远程灰度配置在隐私模式下不出网，各灰度项按未下发处理", async () => {
  const { createElectronDesktopContextPromptConfigFetcher, resolveDesktopContextPromptConfig } =
    await import("../src/main/desktopContextPromptRollout.js");
  const fetchConfig = createElectronDesktopContextPromptConfigFetcher({
    appVersion: "0.0.0",
    deviceMid: FAKE_DEVICE_MID,
    resolveEndpointOrigin: async () => {
      throw new Error("privacy guard leaked a client/configs request");
    },
    getClientLanguage: () => "zh-CN",
  });
  const payload = await fetchConfig(new AbortController().signal);
  assert.deepEqual(resolveDesktopContextPromptConfig(payload), { enabled: false });
});
