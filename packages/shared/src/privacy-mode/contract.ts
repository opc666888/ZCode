/**
 * privacy-mode 对外契约（acp-bridge 隐私模式）。
 * 统一开关：默认开启；ZCODE_PRIVACY_MODE=0（或 false/off/no）关闭并恢复上游出网行为。
 * 求值优先级：运行时环境变量 > 构建期注入的 __ZCODE_PRIVACY_MODE__ > 开启。
 * 不持久化、无事件；每次调用即时求值。
 */
export const PRIVACY_MODE_ENV = "ZCODE_PRIVACY_MODE";

export interface PrivacyModeContract {
  /**
   * 隐私模式是否开启。env 缺省读取当前进程环境；Renderer 等无 process 的环境
   * 取构建期默认（构建时 ZCODE_PRIVACY_MODE=0 才为关闭）。
   */
  isPrivacyMode(env?: Readonly<Record<string, string | undefined>>): boolean;
}
