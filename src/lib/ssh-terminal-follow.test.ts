import { describe, expect, it } from "vitest";

import {
  appendRecordingChunk,
  createRecordingBuffer,
  isNearTerminalBottom,
  SSH_RECORDING_MAX_CHARS,
  SSH_RECORDING_MAX_CHUNKS,
} from "./ssh-terminal-follow";

describe("ssh-terminal-follow", () => {
  it("appends until chunk or char caps", () => {
    const state = createRecordingBuffer();
    expect(appendRecordingChunk(state, "hello")).toBe(true);
    expect(state.chunks).toEqual(["hello"]);
    expect(state.charCount).toBe(5);

    state.charCount = SSH_RECORDING_MAX_CHARS - 1;
    expect(appendRecordingChunk(state, "ab")).toBe(false);
    expect(state.capped).toBe(true);
    expect(appendRecordingChunk(state, "more")).toBe(false);
  });

  it("caps by chunk count", () => {
    const state = createRecordingBuffer();
    state.chunks = Array.from({ length: SSH_RECORDING_MAX_CHUNKS }, () => "x");
    state.charCount = SSH_RECORDING_MAX_CHUNKS;
    expect(appendRecordingChunk(state, "y")).toBe(false);
    expect(state.capped).toBe(true);
  });

  it("detects near-bottom viewport", () => {
    expect(isNearTerminalBottom(100, 100)).toBe(true);
    expect(isNearTerminalBottom(98, 100)).toBe(true);
    expect(isNearTerminalBottom(97, 100)).toBe(false);
  });
});
