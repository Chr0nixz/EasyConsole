import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const bundleDir = join(root, "build", "easy-console");
const sidecarDistDir = join(root, "build", "sidecars");
const tauriBinaryDir = join(root, "src-tauri", "binaries");
const pkgBin = join(root, "node_modules", "@yao-pkg", "pkg", "lib-es5", "bin.js");

const entries = [
  {
    name: "easy-console",
    entry: join(root, "tools", "easy-console", "cli-entry.ts"),
  },
  {
    name: "easy-console-mcp",
    entry: join(root, "tools", "easy-console", "mcp-entry.ts"),
  },
];

function targetTriple() {
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

function pkgTarget() {
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new Error("Sidecar exe packaging currently supports Windows x64 only.");
  }
  return "node22-win-x64";
}

async function bundle(entry, outfile) {
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    banner: {
      js: "import { createRequire } from 'node:module';const require = createRequire(import.meta.url);",
    },
    sourcemap: false,
    logLevel: "info",
    external: [],
  });
}

async function packageExe(input, output) {
  execFileSync(
    process.execPath,
    [pkgBin, "--targets", pkgTarget(), "--output", output, "--public-packages", "*", input],
    { stdio: "inherit", cwd: root },
  );
}

await rm(bundleDir, { recursive: true, force: true });
await rm(sidecarDistDir, { recursive: true, force: true });
await mkdir(bundleDir, { recursive: true });
await mkdir(sidecarDistDir, { recursive: true });
await mkdir(tauriBinaryDir, { recursive: true });

const triple = targetTriple();
for (const item of entries) {
  const bundlePath = join(bundleDir, `${item.name}.mjs`);
  const exePath = join(sidecarDistDir, `${item.name}.exe`);
  const tauriSidecarPath = join(tauriBinaryDir, `${item.name}-${triple}.exe`);

  await bundle(item.entry, bundlePath);
  await packageExe(bundlePath, exePath);
  await copyFile(exePath, tauriSidecarPath);
  console.log(`Created ${tauriSidecarPath}`);
}
