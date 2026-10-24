import { Languages } from "lucide-react";

import { SegmentedControl } from "./ui";
import { useI18n } from "../lib/i18n";
import { supportedLocales, type Locale } from "../lib/i18n-text";

export function LanguageSwitch({ compact = false }: { compact?: boolean }) {
  const { locale, setLocale, t } = useI18n();

  return (
    <div className="flex items-center gap-1.5">
      {!compact ? <Languages className="h-4 w-4 shrink-0 text-app-muted" aria-hidden="true" /> : null}
      <SegmentedControl
        label={t("common.selectLanguage")}
        value={locale}
        options={supportedLocales.map((item) => ({
          value: item,
          label: compact ? compactLabel(item) : t(item === "zh-CN" ? "language.zhShort" : "language.enShort"),
          title: t(item === "zh-CN" ? "language.zh" : "language.en"),
        }))}
        onChange={setLocale}
      />
    </div>
  );
}

function compactLabel(locale: Locale) {
  return locale === "zh-CN" ? "中" : "EN";
}
