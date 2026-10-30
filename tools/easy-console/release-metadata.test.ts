// @vitest-environment node
import { mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createReleaseMetadata, githubReleaseOutputs } from "./release-metadata";

const environment = { eventName: "workflow_dispatch", refType: "branch", refName: "release-preparation", runNumber: "42", sha: "a".repeat(40) };

async function withNotes(notes: string | null, run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "ec-release-notes-"));
  const path = join(directory, "0.5.0.md");
  if (notes !== null) await writeFile(path, notes);
  try { await run(directory); } finally {
    if (notes !== null) await unlink(path);
    await rmdir(directory);
  }
}

describe("release metadata", () => {
  it.each(["branch", "tag"])("keeps a manual run a draft even when dispatched from a %s", async (refType) => {
    await withNotes(null, async (directory) => {
      const metadata = await createReleaseMetadata("0.5.0", directory, { ...environment, refType, refName: "v0.5.0" });
      expect(metadata).toMatchObject({ tag: "manual-42", draft: true, prerelease: true });
      expect(metadata.body).toContain(environment.sha);
      expect(metadata.body).toContain("Packaging rehearsal");
    });
  });

  it("uses exactly the reviewed version notes for a matching tag push", async () => {
    await withNotes("# EasyConsole 0.5.0\n\nMigration notes.\n", async (directory) => {
      const metadata = await createReleaseMetadata("0.5.0", directory, { ...environment, eventName: "push", refType: "tag", refName: "v0.5.0" });
      expect(metadata).toMatchObject({ tag: "v0.5.0", draft: false, prerelease: false, body: "# EasyConsole 0.5.0\n\nMigration notes." });
    });
  });

  it("includes existing notes in a clearly labelled rehearsal", async () => {
    await withNotes("Reviewed notes", async (directory) => {
      const metadata = await createReleaseMetadata("0.5.0", directory, environment);
      expect(metadata.body).toContain("Reviewed notes");
      expect(metadata.body).toContain("Draft prerelease");
    });
  });

  it("refuses a public release without version-specific notes", async () => {
    await withNotes(null, async (directory) => {
      await expect(createReleaseMetadata("0.5.0", directory, { ...environment, eventName: "push", refType: "tag", refName: "v0.5.0" })).rejects.toThrow("Release notes are required");
    });
  });

  it("refuses empty notes", async () => {
    await withNotes(" \n", async (directory) => {
      await expect(createReleaseMetadata("0.5.0", directory, environment)).rejects.toThrow("empty");
    });
  });

  it.each([
    { eventName: "pull_request" },
    { eventName: "push", refType: "tag", refName: "v1.0.0" },
    { runNumber: "42\npublic" },
  ])("rejects an invalid release context: %j", async (overrides) => {
    await expect(createReleaseMetadata("0.5.0", "unused", { ...environment, ...overrides })).rejects.toThrow();
  });

  it("rejects versions that could escape the notes directory", async () => {
    await expect(createReleaseMetadata("../0.5.0", "unused", environment)).rejects.toThrow("major.minor.patch");
  });

  it("preserves multiline notes and uses distinct GitHub-output delimiters", async () => {
    await withNotes("Notes\nbody<<EOF\nEOF", async (directory) => {
      const metadata = await createReleaseMetadata("0.5.0", directory, environment);
      const output = githubReleaseOutputs(metadata);
      expect(output).toContain(metadata.body);
      const delimiters = [...output.matchAll(/^\w+<<(easyconsole_[\w-]+)$/gm)].map((match) => match[1]);
      expect(delimiters).toHaveLength(5);
      expect(new Set(delimiters).size).toBe(5);
    });
  });
});
