import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { I18nProvider, useI18n } from "../../lib/i18n";
import { getRuntimeSettings, setRuntimeSettings } from "../../lib/app-settings";
import { browserRuntime } from "../../lib/runtime";
import { ToastContext, type ToastContextValue } from "../../lib/use-toast";
import type { PortForwardRule, SshConnectionRequest, SshSessionEvent } from "../../lib/types";
import { SshTerminalTab } from "./SshTerminalTab";

vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

let restoreRuntimeSettings: (() => void) | null = null;

function setPortForwardRules(rules: PortForwardRule[]) {
  const previous = getRuntimeSettings();
  restoreRuntimeSettings = () => setRuntimeSettings(previous);
  setRuntimeSettings({ ...previous, ssh: { ...previous.ssh, portForwards: rules } });
}

const xtermMock = vi.hoisted(() => ({
  instances: [] as Array<{
    writes: string[];
    bufferLines: string[];
    options: Record<string, unknown>;
    parseCallbacks: Array<() => void>;
  }>,
}));

vi.mock("@xterm/xterm", () => {
  const disposable = { dispose() {} };
  class Terminal {
    cols = 80;
    rows = 24;
    options: Record<string, unknown>;
    writes: string[] = [];
    bufferLines: string[] = [];
    parseCallbacks: Array<() => void> = [];
    element = document.createElement("div");
    buffer = {
      active: {
        viewportY: 0,
        baseY: 0,
        getLine: (row: number) =>
          row < this.bufferLines.length ? { translateToString: () => this.bufferLines[row] } : undefined,
      },
    };
    loadAddon() {}
    open() {}
    write(data: string, callback?: () => void) {
      this.writes.push(data);
      if (callback) this.parseCallbacks.push(callback);
    }
    writeln(data: string) {
      this.writes.push(`${data}\n`);
    }
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
    constructor(options: Record<string, unknown>) {
      this.options = options;
      xtermMock.instances.push(this);
    }
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
    onDidChangeResults() {
      return { dispose() {} };
    }
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
    xtermMock.instances.length = 0;
    restoreRuntimeSettings?.();
    restoreRuntimeSettings = null;
    Object.defineProperty(browserRuntime, "supportsInAppSsh", { get: () => false, configurable: true });
  });

  it("acknowledges output only after xterm parses it and ignores disposed callbacks", async () => {
    vi.spyOn(browserRuntime, "openSshSession").mockResolvedValue("session-flow");
    vi.spyOn(browserRuntime, "closeSshSession").mockResolvedValue(undefined);
    vi.spyOn(browserRuntime, "onPortForwardStatus").mockResolvedValue(() => {});
    vi.spyOn(browserRuntime, "resizeSshSession").mockResolvedValue(undefined);
    const acknowledge = vi.spyOn(browserRuntime, "acknowledgeSshOutput").mockResolvedValue(undefined);
    let emit: ((event: SshSessionEvent) => void) | undefined;
    vi.spyOn(browserRuntime, "onSshSessionEvent").mockImplementation(async (_id, handler) => {
      emit = handler;
      return () => {};
    });
    const view = render(
      <ToastContext.Provider value={toast}>
        <I18nProvider><Harness /></I18nProvider>
      </ToastContext.Provider>,
    );
    await waitFor(() => expect(emit).toBeDefined());
    act(() => emit?.({ sessionId: "session-flow", kind: "output", data: "日志😀", outputSequence: 1 }));
    expect(acknowledge).not.toHaveBeenCalled();
    act(() => xtermMock.instances[0].parseCallbacks.shift()?.());
    expect(acknowledge).toHaveBeenCalledExactlyOnceWith("session-flow", 1);
    act(() => emit?.({ sessionId: "session-flow", kind: "output", data: "pending", outputSequence: 2 }));
    const pending = xtermMock.instances[0].parseCallbacks.shift();
    view.unmount();
    act(() => pending?.());
    expect(acknowledge).toHaveBeenCalledTimes(1);
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
    await waitFor(() => expect(xtermMock.instances).toHaveLength(1));
    expect(xtermMock.instances[0].options).toMatchObject({ convertEol: false });

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

  it("renders SFTP and port forwarding as mobile content overlays", async () => {
    Object.defineProperty(browserRuntime, "supportsInAppSsh", { value: true, configurable: true });
    vi.spyOn(browserRuntime, "openSshSession").mockResolvedValue("session-1");
    vi.spyOn(browserRuntime, "closeSshSession").mockResolvedValue(undefined);
    vi.spyOn(browserRuntime, "onSshSessionEvent").mockResolvedValue(() => {});
    vi.spyOn(browserRuntime, "onPortForwardStatus").mockResolvedValue(() => {});
    vi.spyOn(browserRuntime, "resizeSshSession").mockResolvedValue(undefined);
    vi.spyOn(browserRuntime, "onSftpProgress").mockResolvedValue(() => {});
    vi.spyOn(browserRuntime, "sftpList").mockResolvedValue([]);

    render(
      <ToastContext.Provider value={toast}>
        <I18nProvider>
          <SshTerminalTab request={request} tabId="tab-overlay" active onStatusChange={() => {}} />
        </I18nProvider>
      </ToastContext.Provider>,
    );

    await waitFor(() => expect(screen.getAllByRole("button", { name: /SFTP|文件管|File manager/ }).some((button) => button.classList.contains("md:hidden"))).toBe(true));
    const sftpButton = screen.getAllByRole("button", { name: /SFTP|文件管|File manager/ }).find((button) => button.classList.contains("md:hidden"));
    expect(sftpButton).toBeDefined();
    if (!sftpButton) throw new Error("Missing mobile SFTP trigger");
    fireEvent.click(sftpButton);
    const sftpPanel = await screen.findByRole("region", { name: /SFTP|文件管|File manager/ });
    expect(sftpButton).toHaveAttribute("aria-expanded", "true");
    expect(sftpButton).toHaveAttribute("aria-controls", "ssh-sftp-panel-tab-overlay");
    expect(sftpPanel).toHaveClass("absolute", "inset-0", "w-full", "md:static", "md:w-80");

    fireEvent.click(within(sftpPanel).getByRole("button", { name: /关闭|Close/ }));
    expect(sftpButton).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(screen.getByRole("button", { name: /更多终端工具|More terminal tools/ }));
    const portButton = await screen.findByRole("menuitem", { name: /端口转发|Port forwards/ });
    expect(portButton).toHaveAttribute("aria-controls", "ssh-port-forward-panel-tab-overlay");
    fireEvent.click(portButton);
    const portPanel = await screen.findByRole("region", { name: /端口转发|Port forwards/ });
    expect(portPanel).toHaveClass("absolute", "inset-0", "w-full", "md:static", "md:w-80");
  });

  it("shows a manual port-forward bind error in the rule row", async () => {
    Object.defineProperty(browserRuntime, "supportsInAppSsh", { value: true, configurable: true });
    setPortForwardRules([{
      id: "manual-forward",
      type: "local",
      localHost: "127.0.0.1",
      localPort: 8080,
      remoteHost: "10.0.0.1",
      remotePort: 80,
      enabled: false,
    }]);
    vi.spyOn(browserRuntime, "openSshSession").mockResolvedValue("session-1");
    vi.spyOn(browserRuntime, "closeSshSession").mockResolvedValue(undefined);
    vi.spyOn(browserRuntime, "onSshSessionEvent").mockResolvedValue(() => {});
    vi.spyOn(browserRuntime, "onPortForwardStatus").mockResolvedValue(() => {});
    vi.spyOn(browserRuntime, "resizeSshSession").mockResolvedValue(undefined);
    vi.spyOn(browserRuntime, "startPortForward").mockRejectedValue(new Error("Address already in use"));

    render(
      <ToastContext.Provider value={toast}>
        <I18nProvider>
          <SshTerminalTab request={request} tabId="tab-forward-error" active onStatusChange={() => {}} />
        </I18nProvider>
      </ToastContext.Provider>,
    );

    await waitFor(() => expect(browserRuntime.openSshSession).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: /更多终端工具|More terminal tools/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /端口转发|Port forwards/ }));
    fireEvent.click(await screen.findByRole("button", { name: /启动|Start/ }));

    expect(await screen.findByText("Address already in use")).toBeInTheDocument();
  });

  it("shows the actual port returned for an automatically allocated forward", async () => {
    Object.defineProperty(browserRuntime, "supportsInAppSsh", { value: true, configurable: true });
    setPortForwardRules([{
      id: "auto-forward",
      type: "local",
      localHost: "127.0.0.1",
      localPort: 0,
      remoteHost: "10.0.0.1",
      remotePort: 80,
      enabled: true,
    }]);
    vi.spyOn(browserRuntime, "openSshSession").mockResolvedValue("session-1");
    vi.spyOn(browserRuntime, "closeSshSession").mockResolvedValue(undefined);
    vi.spyOn(browserRuntime, "onSshSessionEvent").mockResolvedValue(() => {});
    vi.spyOn(browserRuntime, "onPortForwardStatus").mockResolvedValue(() => {});
    vi.spyOn(browserRuntime, "resizeSshSession").mockResolvedValue(undefined);
    vi.spyOn(browserRuntime, "startPortForward").mockResolvedValue(43123);

    render(
      <ToastContext.Provider value={toast}>
        <I18nProvider>
          <SshTerminalTab request={request} tabId="tab-auto-forward" active onStatusChange={() => {}} />
        </I18nProvider>
      </ToastContext.Provider>,
    );

    await waitFor(() => expect(browserRuntime.startPortForward).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: /更多终端工具|More terminal tools/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /端口转发|Port forwards/ }));

    expect(await screen.findByText(/127\.0\.0\.1:43123/)).toBeInTheDocument();
  });

  it("records SSH history for the English connection status emitted by the native side", async () => {
    Object.defineProperty(browserRuntime, "supportsInAppSsh", { value: true, configurable: true });
    const openSshSession = vi.spyOn(browserRuntime, "openSshSession").mockResolvedValue("session-1");
    vi.spyOn(browserRuntime, "closeSshSession").mockResolvedValue(undefined);
    vi.spyOn(browserRuntime, "resizeSshSession").mockResolvedValue(undefined);
    vi.spyOn(browserRuntime, "onPortForwardStatus").mockResolvedValue(() => {});
    vi.spyOn(browserRuntime, "onSftpProgress").mockResolvedValue(() => {});
    vi.spyOn(browserRuntime, "sftpList").mockResolvedValue([]);
    const addSshHistory = vi.spyOn(browserRuntime, "addSshHistory").mockResolvedValue(undefined);

    let handler: ((event: SshSessionEvent) => void) | undefined;
    vi.spyOn(browserRuntime, "onSshSessionEvent").mockImplementation(async (_sessionId, callback) => {
      handler = callback;
      return () => {};
    });

    render(
      <ToastContext.Provider value={toast}>
        <I18nProvider>
          <SshTerminalTab request={request} tabId="tab-history" active onStatusChange={() => {}} />
        </I18nProvider>
      </ToastContext.Provider>,
    );

    await waitFor(() => expect(openSshSession).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(handler).toBeDefined());

    // History recording is driven by the structured phase, not by matching
    // the localized message.
    act(() => {
      handler?.({ sessionId: "session-1", kind: "status", phase: "connected", message: "SSH connected" });
    });

    await waitFor(() => expect(addSshHistory).toHaveBeenCalledTimes(1));
    expect(addSshHistory).toHaveBeenCalledWith(
      expect.objectContaining({ host: "10.0.0.8", port: "30222" }),
      // The configured history limit rides along with the entry.
      expect.any(Number),
    );
  });
});

describe("SshTerminalTab session recovery", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    xtermMock.instances.length = 0;
    restoreRuntimeSettings?.();
    restoreRuntimeSettings = null;
    Object.defineProperty(browserRuntime, "supportsInAppSsh", { get: () => false, configurable: true });
  });

  function mockSessionLifecycle() {
    const openSshSession = vi.spyOn(browserRuntime, "openSshSession").mockResolvedValue("session-1");
    vi.spyOn(browserRuntime, "closeSshSession").mockResolvedValue(undefined);
    vi.spyOn(browserRuntime, "resizeSshSession").mockResolvedValue(undefined);
    vi.spyOn(browserRuntime, "onPortForwardStatus").mockResolvedValue(() => {});
    vi.spyOn(browserRuntime, "onSftpProgress").mockResolvedValue(() => {});
    vi.spyOn(browserRuntime, "sftpList").mockResolvedValue([]);
    let handler: ((event: SshSessionEvent) => void) | undefined;
    vi.spyOn(browserRuntime, "onSshSessionEvent").mockImplementation(async (_sessionId, callback) => {
      handler = callback;
      return () => {};
    });
    return { openSshSession, emit: (event: SshSessionEvent) => handler?.(event) };
  }

  function renderTab(tabId: string) {
    return render(
      <ToastContext.Provider value={toast}>
        <I18nProvider>
          <SshTerminalTab request={request} tabId={tabId} active onStatusChange={() => {}} />
        </I18nProvider>
      </ToastContext.Provider>,
    );
  }

  it("replays preserved scrollback after a reconnect instead of destroying it", async () => {
    Object.defineProperty(browserRuntime, "supportsInAppSsh", { value: true, configurable: true });
    const { openSshSession, emit } = mockSessionLifecycle();

    renderTab("tab-reconnect");

    await waitFor(() => expect(openSshSession).toHaveBeenCalledTimes(1));
    const firstTerminal = xtermMock.instances[0];
    firstTerminal.bufferLines = ["$ train --epochs 10", "epoch 1 loss 0.9"];

    act(() => {
      emit({ sessionId: "session-1", kind: "closed", message: "connection reset" });
    });

    fireEvent.click(screen.getByRole("button", { name: /重连|Reconnect/ }));

    await waitFor(() => expect(openSshSession).toHaveBeenCalledTimes(2));
    const secondTerminal = xtermMock.instances[1];
    await waitFor(() => {
      const replay = secondTerminal.writes.join("");
      expect(replay).toContain("$ train --epochs 10");
      expect(replay).toContain("epoch 1 loss 0.9");
    });
    expect(secondTerminal.writes.join("")).toMatch(/以上为.*重连前的历史输出|Preserved terminal history|Above: output from before/);
    expect(secondTerminal.writes.join("")).toMatch(/正在建立 SSH 连接|Establishing SSH connection/);
  });

  it("marks a closed session with warning styling, an icon, and an end time", async () => {
    Object.defineProperty(browserRuntime, "supportsInAppSsh", { value: true, configurable: true });
    const { openSshSession, emit } = mockSessionLifecycle();

    renderTab("tab-closed");

    await waitFor(() => expect(openSshSession).toHaveBeenCalledTimes(1));

    act(() => {
      emit({ sessionId: "session-1", kind: "closed", message: "connection reset" });
    });

    const statusText = await screen.findByText("connection reset");
    const statusWrap = statusText.parentElement as HTMLElement;
    expect(statusWrap.className).toContain("text-app-warning");
    expect(statusWrap.querySelector("svg")).not.toBeNull();
    expect(statusWrap.textContent).toMatch(/\d{2}:\d{2}/);
  });

  it("focuses Reject by default in the host key prompt", async () => {
    Object.defineProperty(browserRuntime, "supportsInAppSsh", { value: true, configurable: true });
    const { openSshSession, emit } = mockSessionLifecycle();

    renderTab("tab-host-key");

    await waitFor(() => expect(openSshSession).toHaveBeenCalledTimes(1));

    act(() => {
      emit({
        sessionId: "session-1",
        kind: "host-key-prompt",
        message: "Confirm host fingerprint",
        data: JSON.stringify({ promptId: "prompt-1", host: "10.0.0.8", port: 30222, fingerprint: "SHA256:abc" }),
      });
    });

    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByRole("button", { name: /拒绝|Reject/ })).toHaveFocus();
  });

  it("requires an explicit checkbox before accepting a changed key for the same task", async () => {
    Object.defineProperty(browserRuntime, "supportsInAppSsh", { value: true, configurable: true });
    const { openSshSession, emit } = mockSessionLifecycle();
    const confirmHostKey = vi.spyOn(browserRuntime, "confirmKnownHost").mockResolvedValue(undefined);

    renderTab("tab-host-key-changed");
    await waitFor(() => expect(openSshSession).toHaveBeenCalledTimes(1));

    act(() => {
      emit({
        sessionId: "session-1",
        kind: "host-key-prompt",
        data: JSON.stringify({
          promptId: "prompt-changed",
          host: "10.0.0.8",
          port: 30222,
          fingerprint: "SHA256:new",
          previousFingerprint: "SHA256:old",
          taskId: "task-1",
          previousTaskId: "task-1",
          changedKey: true,
          taskChanged: false,
          requiresChangedConfirmation: true,
        }),
      });
    });

    const dialog = await screen.findByRole("alertdialog");
    const trust = within(dialog).getByRole("button", { name: /信任并继续|Trust and continue/ });
    expect(trust).toBeDisabled();
    fireEvent.click(within(dialog).getByRole("checkbox"));
    expect(trust).toBeEnabled();
    fireEvent.click(trust);
    await waitFor(() => expect(confirmHostKey).toHaveBeenCalledWith("prompt-changed", true, true));
  });

  it("shows task reassignment context and allows explicit confirmation without the extra acknowledgement", async () => {
    Object.defineProperty(browserRuntime, "supportsInAppSsh", { value: true, configurable: true });
    const { openSshSession, emit } = mockSessionLifecycle();

    renderTab("tab-host-key-recycled");
    await waitFor(() => expect(openSshSession).toHaveBeenCalledTimes(1));
    act(() => {
      emit({
        sessionId: "session-1",
        kind: "host-key-prompt",
        data: JSON.stringify({
          promptId: "prompt-recycled",
          host: "10.0.0.8",
          port: 30222,
          fingerprint: "SHA256:new",
          previousFingerprint: "SHA256:old",
          taskId: "task-new",
          previousTaskId: "task-old",
          changedKey: true,
          taskChanged: true,
          requiresChangedConfirmation: false,
        }),
      });
    });

    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("task-old")).toBeInTheDocument();
    expect(within(dialog).getByText("task-new")).toBeInTheDocument();
    expect(within(dialog).queryByRole("checkbox")).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /信任并继续|Trust and continue/ })).toBeEnabled();
  });
});
