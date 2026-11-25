// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EasyConsoleApi } from "../../src/lib/api-factory";
import { uploadLocalFile } from "./operations";

function fakeApi() {
  const uploadFile = vi.fn(async () => ({ uploaded: true }));
  return { api: { storageApi: { uploadFile } } as unknown as EasyConsoleApi, uploadFile };
}

describe("uploadLocalFile upload root confinement", () => {
  let root: string;
  let outside: string;
  let previousRoot: string | undefined;

  beforeEach(() => {
    previousRoot = process.env.EASY_CONSOLE_UPLOAD_DIR;
    root = mkdtempSync(join(tmpdir(), "easy-console-uploads-"));
    outside = mkdtempSync(join(tmpdir(), "easy-console-outside-"));
    process.env.EASY_CONSOLE_UPLOAD_DIR = root;
  });

  afterEach(() => {
    if (previousRoot === undefined) {
      delete process.env.EASY_CONSOLE_UPLOAD_DIR;
    } else {
      process.env.EASY_CONSOLE_UPLOAD_DIR = previousRoot;
    }
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("previews a file inside the root with its size and uploads it once confirmed", async () => {
    writeFileSync(join(root, "data.csv"), "a,b\n1,2\n");
    const { api, uploadFile } = fakeApi();

    const preview = await uploadLocalFile(api, "data.csv", "/datasets");
    expect(preview).toMatchObject({ dryRun: true, payload: { localPath: join(root, "data.csv"), filename: "data.csv", bytes: 8 } });
    expect(uploadFile).not.toHaveBeenCalled();

    await uploadLocalFile(api, "data.csv", "/datasets", true);
    expect(uploadFile).toHaveBeenCalledTimes(1);
  });

  it("refuses files outside the root, by absolute path or by ..", async () => {
    writeFileSync(join(outside, "id_rsa"), "PRIVATE KEY");
    const { api, uploadFile } = fakeApi();

    await expect(uploadLocalFile(api, join(outside, "id_rsa"), "/", true)).rejects.toThrow(/outside the upload directory/);
    await expect(uploadLocalFile(api, "../" + join(outside.split("/").pop()!, "id_rsa"), "/", true)).rejects.toThrow(/outside the upload directory/);
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it("refuses a symlink inside the root that points out of it", async () => {
    writeFileSync(join(outside, "config.json"), '{"token":"Bearer secret"}');
    symlinkSync(join(outside, "config.json"), join(root, "innocent.json"));
    const { api, uploadFile } = fakeApi();

    await expect(uploadLocalFile(api, "innocent.json", "/", true)).rejects.toThrow(/symlink or junction/);
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it("refuses anything that is not a regular file, even as a preview", async () => {
    mkdirSync(join(root, "folder"));
    const { api } = fakeApi();

    await expect(uploadLocalFile(api, "folder", "/")).rejects.toThrow(/regular files/);
  });

  it("lets the CLI upload an explicit path outside the root", async () => {
    writeFileSync(join(outside, "report.txt"), "report");
    const { api, uploadFile } = fakeApi();

    await uploadLocalFile(api, join(outside, "report.txt"), "/", true, { allowOutsideRoot: true });
    expect(uploadFile).toHaveBeenCalledTimes(1);
  });
});
