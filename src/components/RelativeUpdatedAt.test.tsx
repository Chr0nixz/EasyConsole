import { render, screen } from "@testing-library/react";
import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { I18N_STORAGE_KEY, I18nProvider } from "../lib/i18n";

import { RelativeUpdatedAt } from "./RelativeUpdatedAt";

describe("RelativeUpdatedAt", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.localStorage.clear();
    window.localStorage.setItem(I18N_STORAGE_KEY, "zh-CN");
    // The provider's first render derives the locale from navigator.language
    // (en in jsdom) before the stored key applies; pin the language so the
    // rendered text is deterministic.
    Object.defineProperty(window.navigator, "language", { configurable: true, get: () => "zh-CN" });
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (window.navigator as unknown as Record<string, unknown>).language;
  });

  it("renders the current age and refreshes on its own timer", () => {
    const updatedAt = Date.now() - 2_000;
    render(
      <I18nProvider>
        <RelativeUpdatedAt updatedAt={updatedAt} intervalMs={5_000} />
      </I18nProvider>,
    );

    expect(screen.getByText("刚刚")).toBeTruthy();

    // The interval fires at t+5s and captures now at fire time: age 2s + 5s.
    act(() => {
      vi.advanceTimersByTime(6_000);
    });
    expect(screen.getByText("7 秒前")).toBeTruthy();
  });

  it("renders in English when the locale is en-US", () => {
    Object.defineProperty(window.navigator, "language", { configurable: true, get: () => "en-US" });
    window.localStorage.setItem(I18N_STORAGE_KEY, "en-US");
    const updatedAt = Date.now() - 30_000;

    render(
      <I18nProvider>
        <RelativeUpdatedAt updatedAt={updatedAt} />
      </I18nProvider>,
    );

    expect(screen.getByText("30s ago")).toBeTruthy();
  });

  it("clamps a future timestamp to just now", () => {
    render(
      <I18nProvider>
        <RelativeUpdatedAt updatedAt={Date.now() + 60_000} />
      </I18nProvider>,
    );

    expect(screen.getByText("刚刚")).toBeTruthy();
  });
});
