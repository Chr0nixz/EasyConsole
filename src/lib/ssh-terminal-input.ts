export type MobileControlResult = {
  /** Text to write to the PTY; null when nothing should be sent. */
  send: string | null;
  /** Whether the virtual Ctrl modifier was consumed and should deactivate. */
  ctrlConsumed: boolean;
};

/**
 * Single input gate for the mobile virtual Ctrl modifier. When Ctrl is armed
 * and a single ASCII letter arrives, it composes the matching C0 control
 * character and consumes the modifier; everything else passes through
 * untouched and leaves the modifier armed so two-key chords keep working.
 *
 * Composing here — and nowhere else — is what prevents the historical
 * double-send bug where the raw letter and its control character both reached
 * the remote shell (`Ctrl+C` inserting `c` and ETX, for example).
 */
export function composeMobileControl(ctrlActive: boolean, data: string): MobileControlResult {
  if (!ctrlActive) return { send: data, ctrlConsumed: false };
  if (data.length === 1 && /[a-zA-Z]/.test(data)) {
    const code = data.toLowerCase().charCodeAt(0) - 96;
    return { send: String.fromCharCode(code), ctrlConsumed: true };
  }
  return { send: data, ctrlConsumed: false };
}
