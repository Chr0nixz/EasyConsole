// @vitest-environment node
import { describe, expect, it } from "vitest";

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
});
