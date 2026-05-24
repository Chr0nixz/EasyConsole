import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, beforeEach } from "vitest";

import { LanguageSwitch } from "../components/LanguageSwitch";
import { I18N_STORAGE_KEY, I18nProvider, useI18n } from "./i18n";

function Probe() {
  const { t } = useI18n();
  return (
    <div>
      <span>{t("shell.logout")}</span>
      <LanguageSwitch />
    </div>
  );
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

    fireEvent.click(screen.getByRole("button", { name: "EN" }));

    expect(await screen.findByText("Sign out")).toBeInTheDocument();
    expect(window.localStorage.getItem(I18N_STORAGE_KEY)).toBe("en-US");
  });
});
