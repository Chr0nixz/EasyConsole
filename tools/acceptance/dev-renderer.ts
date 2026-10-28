import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";

import { TOKEN_STORAGE_KEY } from "../../src/lib/api-client";
import { APP_SETTINGS_STORAGE_KEY } from "../../src/lib/app-settings";

if (!process.env.APPDATA) throw new Error("Desktop acceptance profile requires Windows APPDATA");
const profile = join(process.env.APPDATA, "com.easyconsole.acceptance");
await mkdir(profile, { recursive: true });
const settings = {
  apiBaseUrl: "http://127.0.0.1:28991/api", monitorDashboardUrl: "http://127.0.0.1:28991/monitor",
  autoCheckUpdates: false, notificationPreferences: { "task.success": "off", "task.failure": "off", "task.abnormal": "off", "task.releaseDue": "app", "task.idle": "app" },
};
// Seed only an unused acceptance profile. Migration moves this synthetic token
// into the acceptance identifier's own keychain namespace at first launch.
try {
  await readFile(join(profile, "runtime-storage.d", "manifest.json"), "utf8");
} catch {
  await writeFile(join(profile, "runtime-storage.json"), JSON.stringify({
    [TOKEN_STORAGE_KEY]: "Bearer local-acceptance-token",
    [APP_SETTINGS_STORAGE_KEY]: JSON.stringify(settings),
  }), { flag: "wx" }).catch((error: unknown) => {
    if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
  });
}
const vite = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "1429", "--strictPort"], {
  stdio: "inherit", env: { ...process.env, VITE_API_BASE_URL: settings.apiBaseUrl, VITE_MONITOR_DASHBOARD_URL: settings.monitorDashboardUrl },
});
vite.on("exit", (code) => { process.exitCode = code ?? 1; });
