import type { Config } from "tailwindcss";

// Fonts, colors and radii live in src/styles.css (@theme). Shadows resolve to CSS
// variables there too, so each one follows the active light or dark theme.
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      boxShadow: {
        raised: "var(--app-shadow-raised)",
        shell: "var(--app-shadow-shell)",
        popover: "var(--app-shadow-popover)",
        modal: "var(--app-shadow-modal)",
        stickyColumn: "var(--app-shadow-sticky)",
        stickyColumnSubtle: "var(--app-shadow-sticky-subtle)",
      },
    },
  },
  plugins: [],
} satisfies Config;
