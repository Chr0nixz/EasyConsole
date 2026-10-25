import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { browserRuntime, getRuntimeKind, initRuntimeKind } from "./runtime";

function resetCapabilityGetters() {
  // The production getters read a module-level runtimeKind; restore them after
  // individual tests override them so later tests see fresh state.
  const defaults = {
    isDesktop: false,
    isMobile: false,
    runtimeKind: "web" as const,
    runLogChannel: "web" as const,
    supportsTray: false,
    supportsSystemTerminal: false,
    supportsInAppSsh: false,
    supportsSshPopOut: false,
    supportsUpdater: false,
    supportsFileReveal: false,
  };
  for (const [key, value] of Object.entries(defaults)) {
    Object.defineProperty(browserRuntime, key, {
      get() {
        return value;
      },
      configurable: true,
    });
  }
}

describe("runtime kind resolution", () => {
  afterEach(() => {
    resetCapabilityGetters();
  });

  it("defaults to the web runtime kind in non-Tauri environments", async () => {
    await initRuntimeKind();
    expect(getRuntimeKind()).toBe("web");
  });

  it("initRuntimeKind resolves even when called multiple times", async () => {
    const first = initRuntimeKind();
    const second = initRuntimeKind();
    expect(first).toBe(second);
    await first;
    expect(getRuntimeKind()).toBe("web");
  });

  it("exposes web capability flags in the web runtime", async () => {
    await initRuntimeKind();
    expect(browserRuntime.isDesktop).toBe(false);
    expect(browserRuntime.isMobile).toBe(false);
    expect(browserRuntime.runLogChannel).toBe("web");
    expect(browserRuntime.supportsTray).toBe(false);
    expect(browserRuntime.supportsSystemTerminal).toBe(false);
    expect(browserRuntime.supportsInAppSsh).toBe(false);
    expect(browserRuntime.supportsSshPopOut).toBe(false);
    expect(browserRuntime.supportsUpdater).toBe(false);
    expect(browserRuntime.supportsFileReveal).toBe(false);
  });

  it("exposes full desktop capability flags when running on desktop", () => {
    Object.defineProperty(browserRuntime, "isDesktop", { get: () => true, configurable: true });
    Object.defineProperty(browserRuntime, "isMobile", { get: () => false, configurable: true });
    Object.defineProperty(browserRuntime, "runtimeKind", { get: () => "desktop", configurable: true });
    Object.defineProperty(browserRuntime, "runLogChannel", { get: () => "tauri", configurable: true });
    Object.defineProperty(browserRuntime, "supportsTray", { get: () => true, configurable: true });
    Object.defineProperty(browserRuntime, "supportsSystemTerminal", { get: () => true, configurable: true });
    Object.defineProperty(browserRuntime, "supportsInAppSsh", { get: () => true, configurable: true });
    Object.defineProperty(browserRuntime, "supportsSshPopOut", { get: () => true, configurable: true });
    Object.defineProperty(browserRuntime, "supportsUpdater", { get: () => true, configurable: true });
    Object.defineProperty(browserRuntime, "supportsFileReveal", { get: () => true, configurable: true });

    expect(browserRuntime.isDesktop).toBe(true);
    expect(browserRuntime.isMobile).toBe(false);
    expect(browserRuntime.runtimeKind).toBe("desktop");
    expect(browserRuntime.runLogChannel).toBe("tauri");
    expect(browserRuntime.supportsTray).toBe(true);
    expect(browserRuntime.supportsInAppSsh).toBe(true);
    expect(browserRuntime.supportsSshPopOut).toBe(true);
    expect(browserRuntime.supportsUpdater).toBe(true);
  });

  it("exposes degraded capability flags when running on mobile (phase 1)", () => {
    Object.defineProperty(browserRuntime, "isDesktop", { get: () => false, configurable: true });
    Object.defineProperty(browserRuntime, "isMobile", { get: () => true, configurable: true });
    Object.defineProperty(browserRuntime, "runtimeKind", { get: () => "mobile", configurable: true });
    Object.defineProperty(browserRuntime, "runLogChannel", { get: () => "mobile", configurable: true });
    Object.defineProperty(browserRuntime, "supportsTray", { get: () => false, configurable: true });
    Object.defineProperty(browserRuntime, "supportsSystemTerminal", { get: () => false, configurable: true });
    Object.defineProperty(browserRuntime, "supportsInAppSsh", { get: () => true, configurable: true });
    Object.defineProperty(browserRuntime, "supportsSshPopOut", { get: () => false, configurable: true });
    Object.defineProperty(browserRuntime, "supportsUpdater", { get: () => false, configurable: true });
    Object.defineProperty(browserRuntime, "supportsFileReveal", { get: () => false, configurable: true });

    expect(browserRuntime.isDesktop).toBe(false);
    expect(browserRuntime.isMobile).toBe(true);
    expect(browserRuntime.runtimeKind).toBe("mobile");
    expect(browserRuntime.runLogChannel).toBe("mobile");
    // Mobile supports in-app SSH via russh NDK; tray, updater, system terminal, pop-out remain desktop-only.
    expect(browserRuntime.supportsTray).toBe(false);
    expect(browserRuntime.supportsSystemTerminal).toBe(false);
    expect(browserRuntime.supportsInAppSsh).toBe(true);
    expect(browserRuntime.supportsSshPopOut).toBe(false);
    expect(browserRuntime.supportsUpdater).toBe(false);
    expect(browserRuntime.supportsFileReveal).toBe(false);
  });
});

describe("download timeout behavior", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function sleep(ms: number) {
    return new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  function byte(value: number) {
    return new Uint8Array([value]);
  }

  /** Fake streaming response whose chunks arrive after configured delays. */
  function chunkedResponse(chunks: Array<{ bytes: Uint8Array; delayMs: number }>, signal: AbortSignal) {
    let index = 0;
    const total = chunks.reduce((sum, chunk) => sum + chunk.bytes.byteLength, 0);
    return {
      status: 200,
      headers: new Headers({ "content-length": String(total) }),
      body: {
        getReader: () => ({
          async read() {
            if (index >= chunks.length) return { done: true, value: undefined };
            const chunk = chunks[index];
            index += 1;
            if (chunk.delayMs > 0) await sleep(chunk.delayMs);
            if (signal.aborted) throw new DOMException("The operation was aborted.", "AbortError");
            return { done: false, value: chunk.bytes };
          },
        }),
      },
    };
  }

  function stubFetchWithBody(handler: (signal: AbortSignal) => ReturnType<typeof chunkedResponse>) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        return handler(init?.signal ?? new AbortController().signal) as unknown as Response;
      }),
    );
  }

  it("completes a blob download whose body outlives the timeout budget", async () => {
    // Six chunks with 200ms gaps: 1200ms total against a 500ms timeout. Only
    // the gaps matter once the timer is per-chunk, so the download completes.
    const chunks = [1, 2, 3, 4, 5, 6].map((value) => ({ bytes: byte(value), delayMs: 200 }));
    stubFetchWithBody((signal) => chunkedResponse(chunks, signal));

    const pending = browserRuntime.request<Blob>({
      method: "GET",
      url: "http://host/api/file",
      responseType: "blob",
      timeoutMs: 500,
    });
    for (let step = 0; step < 8; step += 1) {
      await vi.advanceTimersByTimeAsync(200);
    }

    const response = await pending;
    expect(response.data.size).toBe(6);
  });

  it("aborts a blob download once the body stalls past the idle window", async () => {
    const chunks = [
      { bytes: byte(1), delayMs: 0 },
      { bytes: byte(2), delayMs: 10_000 },
    ];
    stubFetchWithBody((signal) => chunkedResponse(chunks, signal));

    const pending = browserRuntime.request<Blob>({
      method: "GET",
      url: "http://host/api/file",
      responseType: "blob",
      timeoutMs: 500,
    });
    const rejection = expect(pending).rejects.toThrow(/abort/i);
    await vi.advanceTimersByTimeAsync(10_600);
    await rejection;
  });

  it("keeps the overall timeout for JSON responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const signal = init?.signal ?? new AbortController().signal;
        return {
          status: 200,
          headers: new Headers(),
          text: async () => {
            await sleep(2_000);
            if (signal.aborted) throw new DOMException("The operation was aborted.", "AbortError");
            return "{}";
          },
        } as unknown as Response;
      }),
    );

    const pending = browserRuntime.request({ method: "GET", url: "http://host/api/demo", timeoutMs: 500 });
    const rejection = expect(pending).rejects.toThrow(/abort/i);
    await vi.advanceTimersByTimeAsync(2_500);
    await rejection;
  });
});
