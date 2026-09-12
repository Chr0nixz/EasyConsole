import { normalizeLocale, setActiveLocale, type Locale } from "../../src/lib/i18n-text";

/**
 * The CLI and MCP surfaces never mount the React `I18nProvider`, which is the
 * only other caller of `setActiveLocale`. Without this the shared `i18nText`
 * helpers stay on the module default (`zh-CN`), so run logs written by the CLI
 * came out in Chinese next to otherwise English command output.
 *
 * Resolution order: explicit `--lang` -> `EASY_CONSOLE_LANG` -> system locale ->
 * English, matching the English-only CLI surface by default.
 */
export function resolveToolLocale(requested?: string): Locale {
  return (
    normalizeLocale(requested) ??
    normalizeLocale(process.env.EASY_CONSOLE_LANG) ??
    normalizeLocale(Intl.DateTimeFormat().resolvedOptions().locale) ??
    "en-US"
  );
}

export function setToolLocale(requested?: string): Locale {
  const locale = resolveToolLocale(requested);
  setActiveLocale(locale);
  return locale;
}

export function initToolLocale(): Locale {
  return setToolLocale();
}
