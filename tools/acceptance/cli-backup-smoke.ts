import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import type { LocalDataBackup } from "../../src/lib/local-data-backup";

const executableArgument = process.argv[2];
if (!executableArgument) throw new Error("Usage: cli-backup-smoke.ts <packaged-cli-path>");
const executable = resolve(executableArgument);
await access(executable);
const directory = await mkdtemp(join(tmpdir(), "easy-console-cli-backup-smoke-"));

function run<T>(profile: string, args: string[], importLegacyRunLogs = false): T {
  const profilePath = join(directory, profile);
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    EASY_CONSOLE_CONFIG: join(profilePath, "config.json"),
    EASY_CONSOLE_LOCAL_DATA_PATH: join(profilePath, "runtime-storage.json"),
    EASY_CONSOLE_API_BASE_URL: "https://acceptance.invalid/api",
    EASY_CONSOLE_TOKEN: "",
    EASY_CONSOLE_LANG: "en-US",
  };
  if (!importLegacyRunLogs) environment.EASY_CONSOLE_RUN_LOG_PATH = join(profilePath, "run-logs.json");

  const result = spawnSync(executable, ["--json", ...args], {
    env: environment,
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const envelope = JSON.parse(result.stdout) as { ok: boolean; data: T; error: unknown };
  assert.equal(envelope.ok, true, JSON.stringify(envelope.error));
  return envelope.data;
}

try {
  const legacyProfile = join(directory, "legacy-cli-profile");
  await mkdir(legacyProfile, { recursive: true });
  const legacyFixture = resolve("tools/acceptance/fixtures/v0.4.27-cli");
  const legacyData = await readFile(join(legacyFixture, "local-data.json"), "utf8");
  const legacyLogs = JSON.parse(await readFile(join(legacyFixture, "run-logs.json"), "utf8")) as Array<Record<string, unknown>>;
  const freshLegacyLogs = JSON.stringify(legacyLogs.map((entry) => ({ ...entry, createdAt: new Date().toISOString() })));
  const legacyDataPath = join(legacyProfile, "local-data.json");
  const legacyLogsPath = join(legacyProfile, "run-logs.json");
  await writeFile(legacyDataPath, legacyData);
  await writeFile(legacyLogsPath, freshLegacyLogs);

  const legacyTemplates = run<Array<{ id: string; name: string; scriptPath?: string; scriptEnv?: Array<{ key: string; value: string }> }>>(
    "legacy-cli-profile",
    ["template", "list"],
    true,
  );
  assert.deepEqual(legacyTemplates.map(({ id, name }) => ({ id, name })), [
    { id: "legacy-cli-template-manual", name: "upgrade-0427-cli-manual" },
    { id: "legacy-cli-template-script", name: "upgrade-0427-cli-script" },
  ]);
  assert.equal(legacyTemplates[1].scriptPath, "python train.py");
  assert.deepEqual(legacyTemplates[1].scriptEnv, [{ key: "EXPERIMENT_ID", value: "upgrade-0427-fixture" }]);

  const legacySchedules = run<Array<{ id: string; name: string; status: string; owner: { key: string } }>>(
    "legacy-cli-profile",
    ["schedule", "list"],
    true,
  );
  assert.deepEqual(legacySchedules.map(({ id, name, status, owner }) => ({ id, name, status, owner: owner.key })), [
    { id: "legacy-cli-schedule-pending", name: "upgrade-0427-cli-pending", status: "pending", owner: "legacy" },
    { id: "legacy-cli-schedule-paused", name: "upgrade-0427-cli-paused", status: "paused", owner: "legacy" },
  ]);
  const migratedLogs = run<{ items: Array<{ id: string; action: string }> }>("legacy-cli-profile", ["run-log", "export"], true).items;
  const expectedLegacyLogIds = legacyLogs.map((entry) => entry.id);
  assert.ok(expectedLegacyLogIds.every((id) => migratedLogs.some((entry) => entry.id === id)));

  const runtimePath = join(legacyProfile, "runtime-storage.json");
  const storeDirectory = runtimePath.replace(/\.json$/i, ".d");
  const markerHash = createHash("sha256").update(resolve(runtimePath)).digest("hex").slice(0, 16);
  const legacyDataMarker = `${legacyDataPath}.shared-${markerHash}.done`;
  const legacyLogsMarker = `${legacyLogsPath}.shared-${markerHash}.done`;
  assert.deepEqual(JSON.parse(await readFile(join(storeDirectory, "manifest.json"), "utf8")), { version: "1" });
  assert.equal(await readFile(legacyDataPath, "utf8"), legacyData);
  assert.equal(await readFile(legacyLogsPath, "utf8"), freshLegacyLogs);
  assert.equal(await readFile(legacyDataMarker, "utf8"), "1\n");
  assert.equal(await readFile(legacyLogsMarker, "utf8"), "1\n");

  const repeatedTemplates = run<Array<{ id: string }>>("legacy-cli-profile", ["template", "list"], true);
  assert.equal(repeatedTemplates.length, legacyTemplates.length);
  const repeatedLogs = run<{ items: Array<{ id: string }> }>("legacy-cli-profile", ["run-log", "export"], true).items;
  assert.ok(expectedLegacyLogIds.every((id) => repeatedLogs.filter((entry) => entry.id === id).length === 1));

  const template = {
    name: "packaged-backup-smoke",
    taskNamePrefix: "packaged-backup-smoke",
    batchCount: 1,
    imageId: "acceptance-image-unused",
    cpu: 2,
    gpu: 0,
    memory: 4,
    price: 1,
    storagePath: "/acceptance",
    mountPath: "/home/ubuntu/acceptance",
    releaseCondition: 1,
  };
  const created = run<{ dryRun: boolean; result: { id: string } }>("source", [
    "template", "create", "--template-json", JSON.stringify(template), "--yes",
  ]);
  assert.equal(created.dryRun, false);
  assert.ok(created.result.id);

  const backupPath = join(directory, "backup.json");
  const preview = run<{ dryRun: boolean }>("source", ["backup", "export", "--output", backupPath]);
  assert.equal(preview.dryRun, true);
  await assert.rejects(access(backupPath), { code: "ENOENT" });

  run("source", ["backup", "export", "--output", backupPath, "--yes"]);
  const backup = JSON.parse(await readFile(backupPath, "utf8")) as LocalDataBackup;
  assert.equal(backup.app, "EasyConsole");
  assert.equal(backup.version, 1);
  assert.equal(backup.includeSecrets, false);
  assert.equal(backup.items.taskTemplates?.length, 1);
  assert.equal(backup.items.token, undefined);
  assert.equal(backup.items.savedAccounts, undefined);

  const fixtureBackup = resolve("tools/acceptance/fixtures/v0.4.27-cli/backup.json");
  const fixtureImportPreview = run<{ dryRun: boolean }>("fixture-target", ["backup", "import", fixtureBackup]);
  assert.equal(fixtureImportPreview.dryRun, true);
  const fixtureImported = run<{ dryRun: boolean }>("fixture-target", ["backup", "import", fixtureBackup, "--yes"]);
  assert.equal(fixtureImported.dryRun, false);
  const fixtureRestored = run<Array<{ id: string; name: string }>>("fixture-target", ["template", "list"]);
  assert.equal(fixtureRestored.length, 2);
  assert.equal(fixtureRestored[0].id, "legacy-cli-template-manual");
  const fixtureRestoredSchedules = run<Array<{ id: string; status: string }>>("fixture-target", ["schedule", "list"]);
  assert.deepEqual(fixtureRestoredSchedules.map(({ id, status }) => ({ id, status })), [
    { id: "legacy-cli-schedule-pending", status: "pending" },
    { id: "legacy-cli-schedule-paused", status: "paused" },
  ]);

  const importPreview = run<{ dryRun: boolean }>("target", ["backup", "import", backupPath]);
  assert.equal(importPreview.dryRun, true);
  assert.deepEqual(run("target", ["template", "list"]), []);
  const imported = run<{ dryRun: boolean }>("target", ["backup", "import", backupPath, "--yes"]);
  assert.equal(imported.dryRun, false);
  const restored = run<Array<{ id: string; name: string }>>("target", ["template", "list"]);
  assert.equal(restored.length, 1);
  assert.equal(restored[0].id, created.result.id);
  assert.equal(restored[0].name, template.name);
  console.log("Packaged CLI backup export/import and dry-run checks passed.");
} finally {
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  await rm(directory, { recursive: true, force: true });
}
