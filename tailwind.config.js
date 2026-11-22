/** @type {import('tailwindcss').Config} */

// Generated from constants/Colors.ts by scripts/native-palette.ts. Do not edit.
// The palette of constants/Colors.ts, by kebab-case name, and nothing else:
// a class naming any other color (`bg-neutral-900`) renders nothing.
// `white/10` and friends are Colors.white10, Tailwind's own opacity modifier.
module.exports = {
  darkMode: "class",
  content: ["./app/**/*.{js,jsx,ts,tsx}", "./components/**/*.{js,jsx,ts,tsx}"],
  theme: {
    colors: {
      primary: "#9334E9",
      "primary-dark": "#7e22ce",
      accent: "#C084FC",
      foreground: "#ECEDEE",
      "foreground-muted": "#9ca3af",
      "foreground-disabled": "#737373",
      surface: "#171717",
      "surface-raised": "#262626",
      border: "#404040",
      white: "#FFFFFF",
      black: "#000000",
      transparent: "transparent",
      danger: "#ef4444",
      "danger-light": "#f87171",
      success: "#22c55e",
      "success-light": "#4ade80",
      warning: "#f59e0b",
      "warning-light": "#fbbf24",
      info: "#3b82f6",
      "info-light": "#60a5fa",
      favorite: "#ec4899",
      "primary-subtle": "rgba(147, 52, 233, 0.2)",
      "danger-subtle": "rgba(239, 68, 68, 0.2)",
      "success-subtle": "rgba(34, 197, 94, 0.2)",
      "warning-subtle": "rgba(245, 158, 11, 0.2)",
      "info-subtle": "rgba(59, 130, 246, 0.2)",
      "surface-translucent": "rgba(23, 23, 23, 0.9)",
    },
    extend: {},
  },
  plugins: [],
};
