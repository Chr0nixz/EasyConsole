import { describe, expect, it } from "vitest";

import {
  appendRecordingChunk,
  createRecordingBuffer,
  isNearTerminalBottom,
  serializeTerminalBuffer,
  SSH_RECORDING_MAX_CHARS,
  SSH_RECORDING_MAX_CHUNKS,
  type TerminalBufferSource,
} from "./ssh-terminal-follow";

function makeBufferSource(lines: string[], rows = 24): TerminalBufferSource {
  return {
    rows,
    buffer: {
      active: {
        baseY: Math.max(0, lines.length - rows),
        getLine: (row: number) => (row < lines.length ? { translateToString: () => lines[row] } : undefined),
      },
    },
  };
}

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

  it("serializes scrollback with trailing blank lines trimmed", () => {
    const source = makeBufferSource(["$ run job", "output line", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""]);
    expect(serializeTerminalBuffer(source)).toBe("$ run job\r\noutput line");
  });

  it("returns an empty string for a blank buffer", () => {
    expect(serializeTerminalBuffer(makeBufferSource(["", ""]))).toBe("");
  });
});
