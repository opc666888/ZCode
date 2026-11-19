import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * 桌面构建期可选能力的唯一解析入口：ARMS RUM 上报、事件上报、自动更新，以及隐私模式默认值。
 * 优先级：构建进程环境变量 > config/private/build-defaults.json（仅内部仓库存在）> 关闭。
 * 规则见 docs/desktop/build-time-optional-capabilities.md。
 *
 * acp-bridge(privacy): 隐私模式（默认开启，构建时 ZCODE_PRIVACY_MODE=0 关闭）下三项能力显式置空，
 * 并断言不存在 config/private 私有默认配置、也没有通过环境变量注入上报端点；见 docs/acp-bridge/PRIVACY.md。
 */
export const PRIVATE_BUILD_DEFAULTS_PATH = resolve(
  import.meta.dirname,
  "../config/private/build-defaults.json",
);

const ENABLED_VALUES = new Set(["1", "true", "yes"]);
const PRIVACY_OFF_VALUES = new Set(["0", "false", "off", "no"]);
// 隐私模式下禁止注入的上报/更新变量（含 Agent OTLP，见 packages/desktop/tsup.config.ts）。
const PRIVACY_FORBIDDEN_BUILD_ENV_KEYS = [
  "ZCODE_ARMS_RUM_ENDPOINT",
  "ZCODE_TELEMETRY_REPORT_ENDPOINT",
  "ZCODE_AUTO_UPDATE",
  "ZCODE_PACKAGED_AGENT_OTEL_ENDPOINT",
  "ZCODE_PACKAGED_AGENT_OTEL_HEADERS",
];

/** 与 @zcode/shared/privacy-mode 同一判定：仅显式 0/false/off/no 关闭。 */
export function resolveBuildPrivacyMode(env = process.env) {
  const raw = typeof env.ZCODE_PRIVACY_MODE === "string" ? env.ZCODE_PRIVACY_MODE : "";
  const value = raw.trim().toLowerCase();
  return value === "" || !PRIVACY_OFF_VALUES.has(value);
}

/** 隐私模式构建断言：不允许任何上报/自动更新变量为非空。 */
function assertPrivacyBuildEnv(env = process.env) {
  const injected = PRIVACY_FORBIDDEN_BUILD_ENV_KEYS.filter((key) => {
    const value = typeof env[key] === "string" ? env[key].trim() : "";
    // 自动更新是开关：显式关闭（0/false 等）允许；端点类变量非空即视为注入。
    return key === "ZCODE_AUTO_UPDATE" ? ENABLED_VALUES.has(value.toLowerCase()) : value !== "";
  });
  if (injected.length > 0) {
    throw new Error(
      `隐私模式构建不允许注入上报/自动更新配置：${injected.join(", ")}（如需上游行为请设 ZCODE_PRIVACY_MODE=0）`,
    );
  }
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readPrivateDefaults(path) {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`构建期私有默认配置必须是 JSON 对象：${path}`);
    }
    return parsed;
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}

function pickValue(env, defaults, key) {
  // 环境变量显式设置（包括空字符串）时优先，空字符串表示关闭该项能力
  if (typeof env[key] === "string") return env[key].trim();
  const value = defaults[key];
  return typeof value === "string" ? value.trim() : "";
}

export async function resolveBuildTimeConfig(
  env = process.env,
  { defaultsPath = PRIVATE_BUILD_DEFAULTS_PATH } = {},
) {
  if (resolveBuildPrivacyMode(env)) {
    // acp-bridge(privacy): 显式置空；私有默认配置存在即失败，避免内部端点被静默打进开源构建。
    if (await pathExists(defaultsPath)) {
      throw new Error(
        `隐私模式构建不允许存在私有构建默认配置：${defaultsPath}（如需上游行为请设 ZCODE_PRIVACY_MODE=0）`,
      );
    }
    assertPrivacyBuildEnv(env);
    return {
      armsRumEndpoint: "",
      telemetryReportEndpoint: "",
      autoUpdateEnabled: false,
      privacyMode: true,
    };
  }
  const defaults = await readPrivateDefaults(defaultsPath);
  return {
    armsRumEndpoint: pickValue(env, defaults, "ZCODE_ARMS_RUM_ENDPOINT"),
    telemetryReportEndpoint: pickValue(env, defaults, "ZCODE_TELEMETRY_REPORT_ENDPOINT"),
    autoUpdateEnabled: ENABLED_VALUES.has(
      pickValue(env, defaults, "ZCODE_AUTO_UPDATE").toLowerCase(),
    ),
    privacyMode: false,
  };
}

export function createBuildTimeConfigDefines(config) {
  return {
    __ZCODE_ARMS_RUM_ENDPOINT__: JSON.stringify(config.armsRumEndpoint),
    __ZCODE_TELEMETRY_REPORT_ENDPOINT__: JSON.stringify(config.telemetryReportEndpoint),
    __ZCODE_AUTO_UPDATE_ENABLED__: JSON.stringify(config.autoUpdateEnabled),
    // acp-bridge(privacy): 缺省视为开启，只有解析结果明确为 false 才注入关闭。
    __ZCODE_PRIVACY_MODE__: JSON.stringify(config.privacyMode !== false),
  };
}
