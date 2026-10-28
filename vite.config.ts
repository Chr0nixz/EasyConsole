import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  build: {
    target: "es2020",
    reportCompressedSize: false,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("@xterm")) return "vendor-xterm";
          if (id.includes("@tanstack")) return "vendor-tanstack";
          if (id.includes("@tauri-apps")) return "vendor-tauri";
          if (id.includes("lucide-react")) return "vendor-icons";
          if (id.includes("zod") || id.includes("commander") || id.includes("@modelcontextprotocol/sdk")) return "vendor-tools";
          if (id.includes("react") || id.includes("react-dom") || id.includes("react-router-dom")) return "vendor-react";
          return "vendor";
        },
      },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: "./src/test/setup.ts",
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}", "tools/easy-console/**/*.ts"],
      exclude: ["**/*.test.{ts,tsx}", "src/test/**", "**/*.d.ts"],
      reporter: ["text-summary", "html", "json-summary"],
      reportOnFailure: true,
      // Baseline floors only move up; new code must bring its own coverage.
      thresholds: {
        lines: 63, statements: 61, functions: 53, branches: 54,
        "src/lib/auth-context.tsx": { lines: 75, statements: 72, functions: 60, branches: 52 },
        "src/lib/api-client.ts": { lines: 95, statements: 93, functions: 100, branches: 83 },
        "src/lib/batch-runner.ts": { lines: 95, statements: 95, functions: 100, branches: 90 },
        "src/lib/schedule-execution.ts": { lines: 90, statements: 90, functions: 95, branches: 74 },
        "src/lib/scheduled-tasks.ts": { lines: 95, statements: 90, functions: 95, branches: 80 },
        "src/components/batch/verify-unknown-items.ts": { lines: 100, statements: 97, functions: 100, branches: 94 },
        "src/pages/ScheduledTasksPage.tsx": { lines: 70, statements: 65, functions: 55, branches: 58 },
        "src/pages/TaskTemplatesPage.tsx": { lines: 52, statements: 50, functions: 42, branches: 40 },
      },
    },
  },
});
