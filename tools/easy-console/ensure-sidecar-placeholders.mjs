import { access, mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * tauri-build fails clippy/check when `bundle.externalBin` files are missing.
 * Real sidecars are produced later by `build:sidecars`; these empty files only
 * satisfy the existence check so Rust can compile first.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const tauriBinaryDir = join(root, "src-tauri", "binaries");
const names = ["easy-console-cli", "easy-console-mcp"];

function targetTriple() {
  const tauriTargetTriple = process.env.TAURI_ENV_TARGET_TRIPLE?.trim();
  if (tauriTargetTriple) return tauriTargetTriple;

  try {
    return execFileSync("rustc", ["--print", "host-tuple"], { encoding: "utf8" }).trim();
  } catch {
    const output = execFileSync("rustc", ["-Vv"], { encoding: "utf8" });
    const hostLine = output.split(/\r?\n/).find((line) => line.startsWith("host:"));
    const triple = hostLine?.split(/\s+/)[1]?.trim();
    if (!triple) throw new Error("Unable to determine Rust host target triple.");
    return triple;
  }
}

const triple = targetTriple();
const extension = triple.includes("windows") ? ".exe" : "";
await mkdir(tauriBinaryDir, { recursive: true });

for (const name of names) {
  const path = join(tauriBinaryDir, `${name}-${triple}${extension}`);
  try {
    await access(path);
  } catch {
    await writeFile(path, "");
  }
}
