import { PRIVACY_MODE_ENV, type PrivacyModeContract } from "./contract.js";

export { PRIVACY_MODE_ENV };
export type { PrivacyModeContract };

// 构建期默认值由 scripts/build-time-config.mjs 注入（tsup：Main/Host/Preload；Vite：Renderer）。
// 未注入（单测、Web、未经构建脚本的运行）时按开启处理。
declare const __ZCODE_PRIVACY_MODE__: boolean;
const BUILD_DEFAULT: boolean =
  typeof __ZCODE_PRIVACY_MODE__ !== "undefined" ? __ZCODE_PRIVACY_MODE__ : true;

const OFF_VALUES = new Set(["0", "false", "off", "no"]);

/**
 * 优先级：运行时环境变量 > 构建期默认 > 开启。
 * 仅 ZCODE_PRIVACY_MODE 显式为 0/false/off/no 才关闭；空串或未设置沿用构建期默认。
 */
export const isPrivacyMode: PrivacyModeContract["isPrivacyMode"] = (env) => {
  const source = env ?? (typeof process !== "undefined" ? process.env : undefined);
  const raw = source?.[PRIVACY_MODE_ENV]?.trim().toLowerCase();
  if (!raw) return BUILD_DEFAULT;
  return !OFF_VALUES.has(raw);
};
