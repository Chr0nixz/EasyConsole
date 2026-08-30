import { act, render } from "@testing-library/react";
import { StrictMode, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { browserRuntime } from "./runtime";
import { MobileBackStackProvider } from "./MobileBackStackProvider";
import { useMobileBackLayer } from "./use-mobile-back-stack";

function Layer({ active, onBack }: { active: boolean; onBack: () => void }) {
  useMobileBackLayer(active, onBack);
  return null;
}

describe("MobileBackStackProvider", () => {
  const originalMatchMedia = window.matchMedia;

  function mockMatchMedia(matches: boolean) {
    const listeners = new Set<(event: MediaQueryListEvent) => void>();
    const media = {
      matches,
      media: "(max-width: 767px)",
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

  afterEach(() => {
    Object.defineProperty(browserRuntime, "isMobile", { get: () => false, configurable: true });
    window.matchMedia = originalMatchMedia;
    window.history.replaceState({}, "", "/");
  });

  it("consumes the most recently registered layer first", () => {
    Object.defineProperty(browserRuntime, "isMobile", { get: () => true, configurable: true });
    const first = vi.fn();
    const second = vi.fn();
    render(
      <MobileBackStackProvider>
        <Layer active onBack={first} />
        <Layer active onBack={second} />
      </MobileBackStackProvider>,
    );

    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(second).toHaveBeenCalledOnce();
    expect(first).not.toHaveBeenCalled();
  });

  it("consumes layers in a compact web viewport even when the runtime is not native mobile", () => {
    mockMatchMedia(true);
    const onBack = vi.fn();
    render(
      <MobileBackStackProvider>
        <Layer active onBack={onBack} />
      </MobileBackStackProvider>,
    );

    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    expect(onBack).toHaveBeenCalledOnce();
  });

  it("does not intercept browser history in a wide web viewport", () => {
    mockMatchMedia(false);
    const onBack = vi.fn();
    render(
      <MobileBackStackProvider>
        <Layer active onBack={onBack} />
      </MobileBackStackProvider>,
    );

    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    expect(onBack).not.toHaveBeenCalled();
  });

  it("does not add duplicate history entries during StrictMode effect replay", async () => {
    Object.defineProperty(browserRuntime, "isMobile", { get: () => true, configurable: true });
    const pushState = vi.spyOn(window.history, "pushState");
    render(
      <StrictMode>
        <MobileBackStackProvider>
          <Layer active onBack={vi.fn()} />
        </MobileBackStackProvider>
      </StrictMode>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(pushState).toHaveBeenCalledOnce();
    pushState.mockRestore();
  });

  it("cleans only its own history sentinel when a layer closes", async () => {
    Object.defineProperty(browserRuntime, "isMobile", { get: () => true, configurable: true });
    const pushState = vi.spyOn(window.history, "pushState");
    const back = vi.spyOn(window.history, "back");
    function Harness() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <Layer active={open} onBack={() => setOpen(false)} />
          <button type="button" onClick={() => setOpen(false)}>close</button>
        </>
      );
    }
    const view = render(
      <MobileBackStackProvider>
        <Harness />
      </MobileBackStackProvider>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(pushState).toHaveBeenCalledOnce();
    await act(async () => {
      view.getByRole("button", { name: "close" }).click();
      await Promise.resolve();
    });
    expect(back).toHaveBeenCalledOnce();
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(back).toHaveBeenCalledOnce();
    pushState.mockRestore();
    back.mockRestore();
  });

  it("keeps one sentinel while nested layers close out of order", async () => {
    Object.defineProperty(browserRuntime, "isMobile", { get: () => true, configurable: true });
    const back = vi.spyOn(window.history, "back");
    function Harness() {
      const [firstOpen, setFirstOpen] = useState(true);
      const [secondOpen, setSecondOpen] = useState(true);
      return (
        <>
          <Layer active={firstOpen} onBack={() => setFirstOpen(false)} />
          <Layer active={secondOpen} onBack={() => setSecondOpen(false)} />
          <button type="button" onClick={() => setFirstOpen(false)}>close first</button>
          <button type="button" onClick={() => setSecondOpen(false)}>close second</button>
        </>
      );
    }
    const view = render(
      <MobileBackStackProvider>
        <Harness />
      </MobileBackStackProvider>,
    );
    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      view.getByRole("button", { name: "close first" }).click();
      await Promise.resolve();
    });
    expect(back).not.toHaveBeenCalled();

    await act(async () => {
      view.getByRole("button", { name: "close second" }).click();
      await Promise.resolve();
    });
    expect(back).toHaveBeenCalledOnce();
    back.mockRestore();
  });
});
