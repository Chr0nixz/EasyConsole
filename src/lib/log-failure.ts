/** Lines that read as a failure: tracebacks, exceptions, fatal signals, OOM, non-zero exits. */
export const ERROR_LINE_PATTERN = /traceback \(most recent call last\)|\b(?:error|exception|fatal|panic|killed|segmentation fault)\b|out of memory|exit(?:ed)? (?:with )?(?:code|status) [1-9]/i;
/** The line that names the failure, e.g. `torch.OutOfMemoryError: CUDA out of memory`. */
const EXCEPTION_LINE_PATTERN = /^\s*[\w.]*(?:Error|Exception|Interrupt)\b:?/;
const EXIT_CODE_PATTERN = /exit(?:ed)? (?:with )?(?:code|status) (\d+)/i;

export type LogFailureSummary = { index: number; line: string; exitCode: string | null };

/** The failure a reader wants first: the last exception line (else the last error-looking line) and any exit code. */
export function findFailureSummary(lines: string[], errorLines: Set<number>): LogFailureSummary | null {
  let exceptionIndex = -1;
  let lastErrorIndex = -1;
  let exitCode: string | null = null;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!errorLines.has(index)) continue;
    if (lastErrorIndex < 0) lastErrorIndex = index;
    if (exitCode === null) exitCode = EXIT_CODE_PATTERN.exec(lines[index])?.[1] ?? null;
    if (exceptionIndex < 0 && EXCEPTION_LINE_PATTERN.test(lines[index])) exceptionIndex = index;
    if (exceptionIndex >= 0 && exitCode !== null) break;
  }
  const index = exceptionIndex >= 0 ? exceptionIndex : lastErrorIndex;
  return index >= 0 ? { index, line: lines[index].trim(), exitCode } : null;
}

/** `findFailureSummary` over a whole log text, for callers that do not already split and scan it. */
export function summarizeLogFailure(text: string): LogFailureSummary | null {
  const lines = text ? text.split("\n") : [];
  const errorLines = new Set<number>();
  lines.forEach((line, index) => {
    if (ERROR_LINE_PATTERN.test(line)) errorLines.add(index);
  });
  return findFailureSummary(lines, errorLines);
}
