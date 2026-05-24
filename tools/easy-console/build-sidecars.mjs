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
  const tauriTargetTriple = process.env.TAURI_ENV_TARGET_TRIPLE?.trim();
  if (tauriTargetTriple) {
    return tauriTargetTriple;
  }

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

function targetPlatform(triple) {
  const platform = process.env.TAURI_ENV_PLATFORM?.trim() || process.platform;
  if (platform === "windows") return "win32";
  if (platform === process.platform && triple.includes("windows")) return "win32";
  if (platform === process.platform && triple.includes("apple-darwin")) return "darwin";
  if (platform === process.platform && triple.includes("linux")) return "linux";
  return platform;
}

function targetArch(triple) {
  const arch = process.env.TAURI_ENV_ARCH?.trim() || process.arch;
  if (arch === "x86_64") return "x64";
  if (arch === "aarch64") return "arm64";
  if (arch === process.arch && triple.startsWith("x86_64-")) return "x64";
  if (arch === process.arch && triple.startsWith("aarch64-")) return "arm64";
  return arch;
}

function executableExtension(platform) {
  return platform === "win32" ? ".exe" : "";
}

function pkgTarget(platform, arch) {
  const pkgPlatform = {
    darwin: "macos",
    linux: "linux",
    win32: "win",
  }[platform];
  const pkgArch = {
    arm64: "arm64",
    x64: "x64",
  }[arch];

  if (!pkgPlatform || !pkgArch) {
    throw new Error(
      `Unsupported sidecar packaging target: ${platform}/${arch}.`,
    );
  }

  return `node22-${pkgPlatform}-${pkgArch}`;
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
    [pkgBin, "--targets", pkgTarget(platform, arch), "--output", output, "--public-packages", "*", input],
    { stdio: "inherit", cwd: root },
  );
}

await rm(bundleDir, { recursive: true, force: true });
await rm(sidecarDistDir, { recursive: true, force: true });
await mkdir(bundleDir, { recursive: true });
await mkdir(sidecarDistDir, { recursive: true });
await mkdir(tauriBinaryDir, { recursive: true });

const triple = targetTriple();
const platform = targetPlatform(triple);
const arch = targetArch(triple);
const extension = executableExtension(platform);
for (const item of entries) {
  const bundlePath = join(bundleDir, `${item.name}.mjs`);
  const executablePath = join(sidecarDistDir, `${item.name}${extension}`);
  const tauriSidecarPath = join(tauriBinaryDir, `${item.name}-${triple}${extension}`);

  await bundle(item.entry, bundlePath);
  await packageExe(bundlePath, executablePath);
  await copyFile(executablePath, tauriSidecarPath);
  console.log(`Created ${tauriSidecarPath}`);
}
