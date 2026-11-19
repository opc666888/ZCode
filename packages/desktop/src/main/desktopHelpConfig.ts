import { net } from "electron";
import {
  buildHelpAppConfigUrl,
  buildZCodeSourceHeadersFromContext,
  createHelpAppConfigReader,
  resolveOptionalZCodeAuthorization,
  type HelpAppConfig,
  type ZCodeJwtTokenResolver,
  ZCODE_ENV,
} from "@zcode/shared";
import { isPrivacyMode } from "@zcode/shared/privacy-mode";

export function createDesktopHelpConfigReader(options: {
  resolveEndpointOrigin: () => Promise<string>;
  appVersion: string;
  deviceMid: string;
  /** 当前界面语言；以前不传，X-Client-Language 固定为 unknown。 */
  getClientLanguage: () => string;
  resolveZcodeJwtToken?: ZCodeJwtTokenResolver;
}) {
  const read = createHelpAppConfigReader({
    fetchImpl: (input, init) => net.fetch(input instanceof URL ? input.href : input, init),
  });
  return async (): Promise<HelpAppConfig | null> => {
    // acp-bridge(privacy): 隐私模式不拉远程帮助配置；返回 null 等价于「远端无配置」，
    // resolveHelpAppConfig 回退到内置 config/default.json（不走失败告警路径）。
    if (isPrivacyMode()) return null;
    const endpointOrigin = await options.resolveEndpointOrigin();
    const authorization = await resolveOptionalZCodeAuthorization(options.resolveZcodeJwtToken);
    return read(
      buildHelpAppConfigUrl(
        endpointOrigin,
        options.appVersion,
        `${process.platform}-${process.arch}`,
      ),
      {
        ...(authorization ? { Authorization: authorization } : {}),
        ...buildZCodeSourceHeadersFromContext({
          endpointOrigin,
          appVersion: options.appVersion,
          clientLanguage: options.getClientLanguage(),
          deviceMid: options.deviceMid,
          platform: process.platform,
          arch: process.arch,
          releaseChannel: ZCODE_ENV,
          sourceTitle: "electron",
        }),
      },
    );
  };
}
