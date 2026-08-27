import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { browserRuntime } from "./runtime";
import { COMPACT_LAYOUT_QUERY, useCompactLayout } from "./use-compact-layout";

function Probe() {
  const compact = useCompactLayout();
  return <div>{compact ? "compact" : "wide"}</div>;
}

function mockMatchMedia(matches: boolean) {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const media = {
    matches,
    media: COMPACT_LAYOUT_QUERY,
    addEventListener(_type: string, listener: (event: MediaQueryListEvent) => void) {
      listeners.add(listener);
    },
    removeEventListener(_type: string, listener: (event: MediaQueryListEvent) => void) {
      listeners.delete(listener);
    },
    dispatch(next: boolean) {
      media.matches = next;
      const event = { matches: next } as MediaQueryListEvent;
      for (const listener of listeners) listener(event);
    },
  };
  window.matchMedia = () => media as unknown as MediaQueryList;
  return media;
}

describe("useCompactLayout", () => {
  const originalMatchMedia = window.matchMedia;

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
    Object.defineProperty(browserRuntime, "isMobile", { get: () => false, configurable: true });
  });

  it("uses the desktop table layout when the viewport is wide", () => {
    mockMatchMedia(false);
    render(<Probe />);
    expect(screen.getByText("wide")).toBeInTheDocument();
  });

  it("switches to compact cards when the viewport is below md", () => {
    const media = mockMatchMedia(false);
    render(<Probe />);
    act(() => media.dispatch(true));
    expect(screen.getByText("compact")).toBeInTheDocument();
  });

  it("stays compact on the native mobile runtime even when the viewport is wide", () => {
    mockMatchMedia(false);
    Object.defineProperty(browserRuntime, "isMobile", { get: () => true, configurable: true });
    render(<Probe />);
    expect(screen.getByText("compact")).toBeInTheDocument();
  });
});
