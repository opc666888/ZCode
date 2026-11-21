import { ZCODE_C360, type Locale } from "@zcode/shared";
import zhCN from "./locales/zh-CN.js";
import enUS from "./locales/en-US.js";
import jaJP from "./locales/ja-JP.js";
import ruRU from "./locales/ru-RU.js";
import koKR from "./locales/ko-KR.js";

/**
 * 语言 → 翻译消息映射。IntlProvider 与 ErrorBoundary 共用这一份。
 * 日/俄/韩文案表可能缺 key（例如官方版本安全校验文案只有中英），缺失时先回退 en-US，
 * 避免界面直接露出 key；中文表是完整的，不需要合并。
 */
/** Claude 360 Code 发行版：界面文案里的产品名统一换成 Claude 360 Code（只换展示文字，key 不动）。 */
const brand = (messages: Record<string, string>): Record<string, string> =>
  ZCODE_C360
    ? Object.fromEntries(Object.entries(messages).map(([k, v]) => [k, v.replace(/ZCode(?! Preview)/g, "Claude 360 Code")]))
    : messages;

const RAW_LOCALE_MESSAGES: Record<Locale, Record<string, string>> = {
  "zh-CN": zhCN,
  "en-US": enUS,
  "ja-JP": { ...enUS, ...jaJP },
  "ru-RU": { ...enUS, ...ruRU },
  "ko-KR": { ...enUS, ...koKR },
};

export const LOCALE_MESSAGES: Record<Locale, Record<string, string>> = Object.fromEntries(
  Object.entries(RAW_LOCALE_MESSAGES).map(([locale, messages]) => [locale, brand(messages)]),
) as Record<Locale, Record<string, string>>;
