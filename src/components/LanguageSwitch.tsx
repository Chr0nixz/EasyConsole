import { Languages } from "lucide-react";

import { supportedLocales, useI18n, type Locale } from "../lib/i18n";
import { cn } from "../lib/utils";

export function LanguageSwitch({ compact = false }: { compact?: boolean }) {
  const { locale, setLocale, t } = useI18n();

  return (
    <div className="flex items-center gap-1 rounded-md border border-app-border bg-app-surface p-1" aria-label={t("common.selectLanguage")}>
      {!compact ? <Languages className="ml-1 h-4 w-4 text-app-muted" /> : null}
      {supportedLocales.map((item) => (
        <button
          aria-pressed={locale === item}
          className={cn(
            "app-interactive h-7 rounded px-2 text-xs font-medium text-app-muted hover:bg-app-panel hover:text-app-text",
            locale === item && "bg-app-accentSoft text-app-accent",
          )}
          key={item}
          onClick={() => setLocale(item)}
          title={t(item === "zh-CN" ? "language.zh" : "language.en")}
          type="button"
        >
          {compact ? compactLabel(item) : t(item === "zh-CN" ? "language.zhShort" : "language.enShort")}
        </button>
      ))}
    </div>
  );
}

function compactLabel(locale: Locale) {
  return locale === "zh-CN" ? "中" : "EN";
}
