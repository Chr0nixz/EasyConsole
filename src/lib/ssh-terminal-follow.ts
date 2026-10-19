export const SSH_RECORDING_MAX_CHUNKS = 20_000;
export const SSH_RECORDING_MAX_CHARS = 2 * 1024 * 1024;
export const SSH_FOLLOW_BOTTOM_THRESHOLD_ROWS = 2;

export type RecordingBufferState = {
  chunks: string[];
  charCount: number;
  capped: boolean;
};

export function createRecordingBuffer(): RecordingBufferState {
  return { chunks: [], charCount: 0, capped: false };
}

/** Returns false when the buffer is capped and the chunk should not be appended. */
export function appendRecordingChunk(state: RecordingBufferState, chunk: string): boolean {
  if (state.capped || !chunk) return false;
  const nextChars = state.charCount + chunk.length;
  const nextChunks = state.chunks.length + 1;
  if (nextChars > SSH_RECORDING_MAX_CHARS || nextChunks > SSH_RECORDING_MAX_CHUNKS) {
    state.capped = true;
    return false;
  }
  state.chunks.push(chunk);
  state.charCount = nextChars;
  return true;
}

export function isNearTerminalBottom(viewportY: number, baseY: number, thresholdRows = SSH_FOLLOW_BOTTOM_THRESHOLD_ROWS) {
  return viewportY >= baseY - thresholdRows;
}

/**
 * Structural view of an xterm.js terminal, so callers (and tests) can pass a
 * mock without importing the xterm runtime into this module.
 */
export type TerminalBufferSource = {
  rows: number;
  buffer: {
    active: {
      baseY: number;
      getLine(row: number): { translateToString(trimRight?: boolean): string } | undefined;
    };
  };
};

/**
 * Serializes the visible scrollback + viewport as plain text. ANSI attributes
 * are intentionally dropped: raw data streams contain cursor-motion sequences
 * that would replay as garbage into a fresh terminal, while plain text stays
 * faithful enough to show "what happened before the reconnect".
 */
export function serializeTerminalBuffer(terminal: TerminalBufferSource): string {
  const buffer = terminal.buffer.active;
  const totalLines = buffer.baseY + terminal.rows;
  const lines: string[] = [];
  for (let row = 0; row < totalLines; row += 1) {
    lines.push(buffer.getLine(row)?.translateToString(true) ?? "");
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines.join("\r\n");
}
