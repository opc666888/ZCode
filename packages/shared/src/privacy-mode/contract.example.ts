import { isPrivacyMode } from "./index.js";

// 调用点只加一行守卫：隐私模式下不发起非用户主动的出网请求。
export function exampleGuardedFetch(): boolean {
  // acp-bridge(privacy): 示例守卫
  if (isPrivacyMode()) return false;
  return true;
}
