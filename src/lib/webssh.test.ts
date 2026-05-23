import { describe, expect, it } from "vitest";

import { deriveWebsshUrl, formatTerminalInput, formatTerminalResize } from "./webssh";

describe("webssh", () => {
  it("derives websocket endpoint from api base", () => {
    expect(deriveWebsshUrl(12, 100, 30, "http://example.com/api")).toBe("ws://example.com/ws/webssh?task_id=12&cols=100&rows=30");
  });

  it("formats terminal input messages", () => {
    expect(formatTerminalInput("ls\n")).toBe(JSON.stringify({ status: 0, data: "ls\n" }));
  });

  it("formats resize messages", () => {
    expect(formatTerminalResize(80, 24)).toBe(JSON.stringify({ status: 1, cols: 80, rows: 24 }));
  });
});
