import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, beforeEach } from "vitest";

import { LanguageSwitch } from "../components/LanguageSwitch";
import { I18N_STORAGE_KEY, I18nProvider, useI18n } from "./i18n";
import { i18nText } from "./i18n-text";

function Probe() {
  const { t } = useI18n();
  return (
    <div>
      <span>{t("shell.logout")}</span>
      <span>{t("notify.permissionDenied")}</span>
      <LanguageSwitch />
    </div>
  );
}

/**
 * Mirrors how `src/lib/*.ts` helpers produce render-path strings: through the
 * module-level `i18nText` rather than the React context. It still reads the
 * context so it re-renders on a language switch, the way real screens do.
 */
function ImperativeProbe() {
  const { locale } = useI18n();
  return <span data-testid="imperative" data-locale={locale}>{i18nText("中文占位", "English placeholder")}</span>;
}

describe("i18n", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("switches language and persists the selected locale", async () => {
    window.localStorage.setItem(I18N_STORAGE_KEY, "zh-CN");
    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    );

    expect(await screen.findByText("退出")).toBeInTheDocument();
    expect(screen.getByText("系统通知未开启")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "EN" }));

    expect(await screen.findByText("Sign out")).toBeInTheDocument();
    expect(screen.getByText("System notifications are disabled")).toBeInTheDocument();
    expect(window.localStorage.getItem(I18N_STORAGE_KEY)).toBe("en-US");
  });

  it("keeps module-level i18nText in step with the locale on the switching render", async () => {
    window.localStorage.setItem(I18N_STORAGE_KEY, "zh-CN");
    render(
      <I18nProvider>
        <ImperativeProbe />
        <LanguageSwitch />
      </I18nProvider>,
    );

    // The stored locale is read asynchronously, so the first paint uses the
    // browser-detected one; wait for zh-CN to land before switching.
    expect(await screen.findByText("中文占位")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "EN" }));

    // Syncing the module-level locale in an effect instead of during render
    // leaves this string one render behind the context-driven ones.
    expect(await screen.findByText("English placeholder")).toBeInTheDocument();
  });
});
