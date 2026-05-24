import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function runNodeScript(script, args = []) {
  execFileSync(process.execPath, [script, ...args], {
    cwd: root,
    stdio: "inherit",
  });
}

runNodeScript(join(root, "tools", "easy-console", "build-sidecars.mjs"));
runNodeScript(join(root, "node_modules", "typescript", "bin", "tsc"), ["-b"]);
runNodeScript(join(root, "node_modules", "vite", "bin", "vite.js"), ["build"]);
