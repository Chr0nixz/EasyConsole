import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Inter", "-apple-system", "BlinkMacSystemFont", "Segoe UI", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "SFMono-Regular", "Consolas", "monospace"],
      },
      colors: {
        app: {
          bg: "oklch(0.982 0.006 95)",
          surface: "oklch(0.995 0.004 95)",
          panel: "oklch(0.955 0.008 95)",
          border: "oklch(0.86 0.012 95)",
          text: "oklch(0.23 0.018 255)",
          muted: "oklch(0.48 0.018 255)",
          accent: "oklch(0.54 0.145 250)",
          accentSoft: "oklch(0.94 0.035 250)",
          success: "oklch(0.54 0.12 150)",
          warning: "oklch(0.72 0.13 78)",
          danger: "oklch(0.58 0.18 25)",
        },
      },
      boxShadow: {
        shell: "0 1px 0 oklch(0.86 0.012 95)",
        popover: "0 18px 45px rgb(31 41 55 / 0.16)",
      },
    },
  },
  plugins: [],
} satisfies Config;
