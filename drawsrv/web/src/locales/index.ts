import en from "./en.ts";
import zhCN from "./zh-CN.ts";
import type { Locale } from "./types.ts";
export type { Locale } from "./types.ts";

export type Language = "en" | "zh-CN";

// Match the first supported language family in browser preference order.
// Regional English variants use English; Chinese variants use Simplified Chinese.
export function selectLanguage(preferences: readonly string[]): Language {
  for (const preference of preferences) {
    const family = preference.trim().toLowerCase().split("-")[0];
    if (family === "en") return "en";
    if (family === "zh") return "zh-CN";
  }
  return "zh-CN";
}
const locales: Record<Language, Locale> = { en, "zh-CN": zhCN };
let language: Language = "zh-CN";
export let locale: Locale = locales[language];
export const getLanguage = () => language;
export function setLanguage(value: Language) {
  language = value;
  locale = locales[value];
}
