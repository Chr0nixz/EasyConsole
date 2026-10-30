// @vitest-environment node
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeBlobToFile } from "./operations";

describe("writeBlobToFile download root confinement", () => {
  let root: string;
  let outside: string;
  let previousRoot: string | undefined;

  beforeEach(() => {
    previousRoot = process.env.EASY_CONSOLE_DOWNLOAD_DIR;
    root = mkdtempSync(join(tmpdir(), "easy-console-downloads-"));
    outside = mkdtempSync(join(tmpdir(), "easy-console-outside-"));
    process.env.EASY_CONSOLE_DOWNLOAD_DIR = root;
  });

  afterEach(() => {
    if (previousRoot === undefined) {
      delete process.env.EASY_CONSOLE_DOWNLOAD_DIR;
    } else {
      process.env.EASY_CONSOLE_DOWNLOAD_DIR = previousRoot;
    }
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("writes a relative path inside the download root", async () => {
    const result = await writeBlobToFile(new Blob(["report-body"]), "reports/report.json");

    expect(result.path).toBe(join(root, "reports", "report.json"));
    expect(readFileSync(join(root, "reports", "report.json"), "utf8")).toBe("report-body");
  });

  it("refuses paths that escape the root with ..", async () => {
    await expect(writeBlobToFile(new Blob(["x"]), "../escaped.txt")).rejects.toThrow(
      /outside the download directory/,
    );
    expect(existsSync(join(root, "..", "escaped.txt"))).toBe(false);
  });

  it("refuses writing through a junction that points outside the root", async () => {
    symlinkSync(outside, join(root, "escape"), "junction");

    await expect(
      writeBlobToFile(new Blob(["x"]), join(root, "escape", "dropped.txt")),
    ).rejects.toThrow(/symlink or junction/);
    expect(existsSync(join(outside, "dropped.txt"))).toBe(false);
  });

  it("refuses a symlinked final path component even when it stays inside the root", async () => {
    writeFileSync(join(root, "real.txt"), "original");
    symlinkSync(join(root, "real.txt"), join(root, "link.txt"), "junction");

    await expect(writeBlobToFile(new Blob(["x"]), "link.txt")).rejects.toThrow(/symlink or junction/);
    expect(readFileSync(join(root, "real.txt"), "utf8")).toBe("original");
  });

  it("refuses to overwrite an existing file unless overwrite is passed", async () => {
    await writeBlobToFile(new Blob(["first"]), "report.json");

    await expect(writeBlobToFile(new Blob(["second"]), "report.json")).rejects.toThrow(
      /Refusing to overwrite/,
    );

    await writeBlobToFile(new Blob(["second"]), "report.json", { overwrite: true });
    expect(readFileSync(join(root, "report.json"), "utf8")).toBe("second");
  });
});
