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
