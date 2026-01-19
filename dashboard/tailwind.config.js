/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        ink:     "#0a0a0f",
        surface: "#111118",
        brd:     "#1e1e2e",
        accent:  "#00ff88",
        danger:  "#ff3366",
        warn:    "#ffaa00",
        primary: "#e2e8f0",
        muted:   "#64748b",
        sev1:    "#ff3366",
        sev2:    "#ff6b35",
        sev3:    "#ffaa00",
        sev4:    "#00ff88",
      },
      fontFamily: {
        mono: ["JetBrains Mono", "ui-monospace", "monospace"],
        sans: ["DM Sans", "system-ui", "sans-serif"],
      },
      keyframes: {
        "pulse-dot": {
          "0%, 100%": { opacity: "1", transform: "scale(1)" },
          "50%": { opacity: "0.4", transform: "scale(0.75)" },
        },
        "slide-in": {
          from: { opacity: "0", transform: "translateY(-6px)" },
          to:   { opacity: "1", transform: "translateY(0)" },
        },
        "fade-in": {
          from: { opacity: "0" },
          to:   { opacity: "1" },
        },
      },
      animation: {
        "pulse-dot": "pulse-dot 2s ease-in-out infinite",
        "slide-in":  "slide-in 0.3s ease-out",
        "fade-in":   "fade-in 0.5s ease-out",
      },
    },
  },
  plugins: [require("@tailwindcss/typography")],
};
