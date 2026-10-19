import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Inter", "-apple-system", "BlinkMacSystemFont", "Segoe UI", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "SFMono-Regular", "Consolas", "monospace"],
      },
      boxShadow: {
        shell: "0 1px 0 oklch(0.86 0.012 95)",
        popover: "0 18px 45px oklch(0.23 0.018 255 / 0.16)",
        stickyColumn: "-10px 0 16px -16px oklch(0.23 0.018 255 / 0.45)",
        stickyColumnSubtle: "-8px 0 12px -12px oklch(0.23 0.018 255 / 0.35)",
      },
    },
  },
  plugins: [],
} satisfies Config;
