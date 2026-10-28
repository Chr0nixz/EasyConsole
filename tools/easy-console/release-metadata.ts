import { randomUUID } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type ReleaseEnvironment = {
  eventName: string;
  refType: string;
  refName: string;
  runNumber: string;
  sha: string;
};

export async function createReleaseMetadata(version: string, notesDirectory: string, environment: ReleaseEnvironment) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Release version must use major.minor.patch.");
  const tagPush = environment.eventName === "push" && environment.refType === "tag";
  if (!tagPush && environment.eventName !== "workflow_dispatch") throw new Error("Only tag pushes and manual dispatches can prepare a release.");
  if (tagPush && environment.refName !== `v${version}`) throw new Error("Release tag does not match the project version.");
  if (!/^(?:\d+|local)$/.test(environment.runNumber)) throw new Error("Invalid release run number.");
  const tag = tagPush ? environment.refName : `manual-${environment.runNumber}`;
  const notesPath = join(notesDirectory, `${version}.md`);
  let notes: string;
  try {
    notes = (await readFile(notesPath, "utf8")).trim();
    if (!notes) throw new Error(`Release notes are empty: ${notesPath}`);
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    if (tagPush) throw new Error(`Release notes are required before publishing: ${notesPath}`, { cause: error });
    notes = Object.values({
      zh: "本次仅验证安装包、签名与更新元数据，不代表升级或真机验收通过。",
      en: "This build validates packaging, signing and updater metadata only; installer upgrades and device acceptance remain separate.",
    }).join("\n");
  }
  const body = tagPush ? notes : [
    "EasyConsole 打包演练 / Packaging rehearsal",
    `Version: ${version}\nSource: ${environment.sha}\nRun: ${environment.runNumber}`,
    "草稿预发布，不进入生产自动更新。\nDraft prerelease; excluded from production automatic updates.",
    notes,
  ].join("\n\n");
  return { tag, name: `EasyConsole ${tag}`, draft: !tagPush, prerelease: !tagPush, body };
}

export function githubReleaseOutputs(metadata: Awaited<ReturnType<typeof createReleaseMetadata>>) {
  return Object.entries(metadata).map(([key, value]) => {
    const delimiter = `easyconsole_${randomUUID()}`;
    return `${key}<<${delimiter}\n${String(value)}\n${delimiter}\n`;
  }).join("");
}

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version: string };
  const metadata = await createReleaseMetadata(version, join(root, "docs", "releases"), {
    eventName: process.env.GITHUB_EVENT_NAME ?? "workflow_dispatch",
    refType: process.env.GITHUB_REF_TYPE ?? "branch",
    refName: process.env.GITHUB_REF_NAME ?? "local",
    runNumber: process.env.GITHUB_RUN_NUMBER ?? "local",
    sha: process.env.GITHUB_SHA ?? "local preview",
  });
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, githubReleaseOutputs(metadata), "utf8");
    console.log(`Prepared ${metadata.tag}: draft=${metadata.draft}, prerelease=${metadata.prerelease}.`);
  } else {
    console.log(JSON.stringify(metadata, null, 2));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
