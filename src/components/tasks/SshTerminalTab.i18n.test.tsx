import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { I18nProvider, useI18n } from "../../lib/i18n";
import { browserRuntime } from "../../lib/runtime";
import { ToastContext, type ToastContextValue } from "../../lib/use-toast";
import type { SshConnectionRequest } from "../../lib/types";
import { SshTerminalTab } from "./SshTerminalTab";

vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

vi.mock("@xterm/xterm", () => {
  const disposable = { dispose() {} };
  class Terminal {
    cols = 80;
    rows = 24;
    element = document.createElement("div");
    buffer = { active: { viewportY: 0, baseY: 0 } };
    loadAddon() {}
    open() {}
    write() {}
    writeln() {}
    focus() {}
    dispose() {}
    scrollToBottom() {}
    paste() {}
    getSelection() {
      return "";
    }
    onData() {
      return disposable;
    }
    onKey() {
      return disposable;
    }
    onScroll() {
      return disposable;
    }
    attachCustomKeyEventHandler() {}
  }
  return { Terminal };
});

vi.mock("@xterm/addon-fit", () => {
  class FitAddon {
    fit() {}
    dispose() {}
  }
  return { FitAddon };
});

vi.mock("@xterm/addon-search", () => {
  class SearchAddon {
    findNext() {}
    findPrevious() {}
    clearDecorations() {}
    dispose() {}
  }
  return { SearchAddon };
});

vi.mock("@xterm/addon-web-links", () => {
  class WebLinksAddon {
    dispose() {}
  }
  return { WebLinksAddon };
});

vi.mock("@xterm/addon-webgl", () => {
  class WebglAddon {
    dispose() {}
  }
  return { WebglAddon };
});

const toast: ToastContextValue = {
  notify: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
};

const request: SshConnectionRequest = {
  host: "10.0.0.8",
  port: "30222",
  username: "ubuntu",
  password: "pw",
  taskId: "task-1",
  taskName: "demo",
  command: "ssh -p 30222 ubuntu@10.0.0.8",
};

function Harness() {
  const { locale, setLocale } = useI18n();
  return (
    <>
      <span data-testid="locale">{locale}</span>
      <button type="button" onClick={() => setLocale("zh-CN")}>
        to-zh
      </button>
      <button type="button" onClick={() => setLocale("en-US")}>
        to-en
      </button>
      <SshTerminalTab request={request} tabId="tab-1" active onStatusChange={() => {}} />
    </>
  );
}

describe("SshTerminalTab language switching", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps the live session open when the UI language changes", async () => {
    const openSshSession = vi.spyOn(browserRuntime, "openSshSession").mockResolvedValue("session-1");
    const closeSshSession = vi.spyOn(browserRuntime, "closeSshSession").mockResolvedValue(undefined);
    vi.spyOn(browserRuntime, "onSshSessionEvent").mockResolvedValue(() => {});
    vi.spyOn(browserRuntime, "onPortForwardStatus").mockResolvedValue(() => {});
    vi.spyOn(browserRuntime, "resizeSshSession").mockResolvedValue(undefined);

    render(
      <ToastContext.Provider value={toast}>
        <I18nProvider>
          <Harness />
        </I18nProvider>
      </ToastContext.Provider>,
    );

    await waitFor(() => expect(openSshSession).toHaveBeenCalledTimes(1));

    // Pin a known starting locale first: jsdom may default to en-US.
    fireEvent.click(screen.getByRole("button", { name: "to-zh" }));
    await waitFor(() => expect(screen.getByTestId("locale")).toHaveTextContent("zh-CN"));

    fireEvent.click(screen.getByRole("button", { name: "to-en" }));
    // Once the locale has actually flipped, any effect depending on `text` would
    // already have run its cleanup and closed the session.
    await waitFor(() => expect(screen.getByTestId("locale")).toHaveTextContent("en-US"));

    expect(closeSshSession).not.toHaveBeenCalled();
    expect(openSshSession).toHaveBeenCalledTimes(1);
  });
});
