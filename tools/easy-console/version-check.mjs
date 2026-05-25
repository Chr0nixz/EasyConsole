import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function cargoVersion(text) {
  const match = text.match(/^\s*version\s*=\s*"([^"]+)"/m);
  if (!match) throw new Error("Unable to find src-tauri/Cargo.toml package version.");
  return match[1];
}

const packageJson = await readJson(join(root, "package.json"));
const tauriConfig = await readJson(join(root, "src-tauri", "tauri.conf.json"));
const cargoToml = await readFile(join(root, "src-tauri", "Cargo.toml"), "utf8");

const versions = {
  "package.json": packageJson.version,
  "src-tauri/tauri.conf.json": tauriConfig.version,
  "src-tauri/Cargo.toml": cargoVersion(cargoToml),
};

const unique = new Set(Object.values(versions));
if (unique.size !== 1) {
  console.error("Version mismatch:");
  for (const [file, version] of Object.entries(versions)) {
    console.error(`- ${file}: ${version}`);
  }
  process.exit(1);
}

const version = packageJson.version;
const refName = process.env.GITHUB_REF_NAME;
if (refName?.startsWith("v") && refName !== `v${version}`) {
  console.error(`Release tag ${refName} does not match project version v${version}.`);
  process.exit(1);
}

console.log(`EasyConsole version ${version} is consistent.`);
