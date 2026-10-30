// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { ApiClient } from "../../src/lib/api-client";
import { ApiError } from "../../src/lib/types";
import { createNodeRuntime } from "./node-runtime";

describe("node runtime", () => {
  it("serializes query, body, and injected auth headers through ApiClient", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const runtime = createNodeRuntime({
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response(JSON.stringify({ code: 0, data: { ok: true } }), { status: 200 });
      },
    });
    const client = new ApiClient(runtime, "http://host/api");
    client.setToken("Bearer token-1");

    const data = await client.post<{ ok: boolean }>("/demo", { name: "x" }, { query: { page: 1, empty: "" } });

    expect(data).toEqual({ ok: true });
    expect(calls[0].url).toBe("http://host/api/demo?page=1");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers).toMatchObject({
      Authorization: "Bearer token-1",
      "Content-Type": "application/json",
    });
    expect(calls[0].init.body).toBe(JSON.stringify({ name: "x" }));
  });

  it("maps business errors from envelopes", async () => {
    const runtime = createNodeRuntime({
      fetch: async () => new Response(JSON.stringify({ code: 10040, msg: "no permission", data: null }), { status: 200 }),
    });
    const client = new ApiClient(runtime, "http://host/api");

    await expect(client.get("/demo")).rejects.toMatchObject({
      name: "ApiError",
      kind: "business",
      code: 10040,
      message: "no permission",
    } satisfies Partial<ApiError>);
  });

  it("maps HTTP 401 as login expiry", async () => {
    const runtime = createNodeRuntime({
      fetch: async () => new Response("{}", { status: 401 }),
    });
    const client = new ApiClient(runtime, "http://host/api");

    await expect(client.get("/demo")).rejects.toMatchObject({
      name: "ApiError",
      kind: "http",
      status: 401,
      code: 10000,
    } satisfies Partial<ApiError>);
  });

  it("completes a blob download whose body outlives the timeout budget", async () => {
    vi.useFakeTimers();
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      });
    const chunks = [1, 2, 3, 4, 5].map((value) => ({ bytes: new Uint8Array([value]), delayMs: 150 }));
    const runtime = createNodeRuntime({
      fetch: (async (_url: RequestInfo | URL, init?: RequestInit) => {
        const signal = init?.signal ?? new AbortController().signal;
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
      }) as typeof fetch,
    });

    const pending = runtime.request<Blob>({
      method: "GET",
      url: "http://host/api/file",
      responseType: "blob",
      timeoutMs: 400,
    });
    for (let step = 0; step < 7; step += 1) {
      await vi.advanceTimersByTimeAsync(150);
    }
    const response = await pending;

    expect(response.data.size).toBe(5);
    vi.useRealTimers();
  });

  it("aborts a blob download once the body stalls past the idle window", async () => {
    vi.useFakeTimers();
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      });
    const chunks = [
      { bytes: new Uint8Array([1]), delayMs: 0 },
      { bytes: new Uint8Array([2]), delayMs: 10_000 },
    ];
    const runtime = createNodeRuntime({
      fetch: (async (_url: RequestInfo | URL, init?: RequestInit) => {
        const signal = init?.signal ?? new AbortController().signal;
        let index = 0;
        return {
          status: 200,
          headers: new Headers({ "content-length": "2" }),
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
      }) as typeof fetch,
    });

    const pending = runtime.request<Blob>({
      method: "GET",
      url: "http://host/api/file",
      responseType: "blob",
      timeoutMs: 400,
    });
    const rejection = expect(pending).rejects.toThrow(/abort/i);
    await vi.advanceTimersByTimeAsync(10_500);
    await rejection;
    vi.useRealTimers();
  });
});
