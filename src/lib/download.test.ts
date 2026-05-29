import { describe, expect, it } from "vitest";

import { sanitizeDownloadFilename } from "./download";

describe("download helpers", () => {
  it("sanitizes unsafe local filenames", () => {
    expect(sanitizeDownloadFilename('bad<name>:"/\\|?*.zip')).toBe("bad_name________.zip");
    expect(sanitizeDownloadFilename("CON")).toBe("easy-console-download");
    expect(sanitizeDownloadFilename("  report.zip. ")).toBe("report.zip");
  });
});
