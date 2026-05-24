export const supportedLocales = ["zh-CN", "en-US"] as const;
export type Locale = (typeof supportedLocales)[number];

let activeLocale: Locale = "zh-CN";

export function getActiveLocale() {
  return activeLocale;
}

export function setActiveLocale(locale: Locale) {
  activeLocale = locale;
}

export function i18nText(zh: string, en: string) {
  return activeLocale === "en-US" ? en : zh;
}

export function normalizeLocale(value: string | null | undefined): Locale | null {
  if (!value) return null;
  const normalized = value.toLowerCase();
  if (normalized.startsWith("en")) return "en-US";
  if (normalized.startsWith("zh")) return "zh-CN";
  return null;
}
