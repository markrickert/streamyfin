/**
 * The palette. Every color of the app is one of these, and
 * `tailwind.config.js` holds the same values under kebab-case names
 * (`foregroundMuted` is `foreground-muted`). `constants/Colors.test.ts` fails
 * when the two drift apart. See docs/conventions/colors.md.
 */
export const Colors = {
  /** Brand color: primary buttons, selection, progress. */
  primary: "#9334E9",
  /** Borders on a primary fill. */
  primaryDark: "#7e22ce",
  /** Lighter brand color for text, icons and switches on a dark surface. */
  accent: "#C084FC",

  /** Text and icons. */
  foreground: "#ECEDEE",
  /** Secondary text, section headers, inactive icons. */
  foregroundMuted: "#9ca3af",
  /** Disabled and placeholder text, empty state icons. */
  foregroundDisabled: "#737373",

  /** Sheets, cards and panels. */
  surface: "#171717",
  /** Rows, inputs and anything sitting on a surface. */
  surfaceRaised: "#262626",
  /** Separators and outlines. */
  border: "#404040",

  /** White fills such as focused TV buttons, and light overlays. */
  white: "#FFFFFF",
  /** Page background, text on white, shadows and dark overlays. */
  black: "#000000",
  transparent: "transparent",

  /** Errors, destructive actions, the LIVE badge. */
  danger: "#ef4444",
  /** Error text and icons on a dark surface, borders on a danger fill. */
  dangerLight: "#f87171",
  /** Success and available states. */
  success: "#22c55e",
  /** Success text on a dark surface, borders on a success fill. */
  successLight: "#4ade80",
  /** Warning fills and pending states. */
  warning: "#f59e0b",
  /** Warning text and icons, ratings, borders on a warning fill. */
  warningLight: "#fbbf24",
  /** Links, informational badges, processing states. */
  info: "#3b82f6",
  /** Info text on a dark surface, borders on an info fill. */
  infoLight: "#60a5fa",
  /** The favorite heart. */
  favorite: "#ec4899",

  white05: "rgba(255, 255, 255, 0.05)",
  white10: "rgba(255, 255, 255, 0.1)",
  white20: "rgba(255, 255, 255, 0.2)",
  white30: "rgba(255, 255, 255, 0.3)",
  white50: "rgba(255, 255, 255, 0.5)",
  white80: "rgba(255, 255, 255, 0.8)",
  black10: "rgba(0, 0, 0, 0.1)",
  black30: "rgba(0, 0, 0, 0.3)",
  black50: "rgba(0, 0, 0, 0.5)",
  black60: "rgba(0, 0, 0, 0.6)",
  black80: "rgba(0, 0, 0, 0.8)",
  primarySubtle: "rgba(147, 52, 233, 0.2)",
  dangerSubtle: "rgba(239, 68, 68, 0.2)",
  successSubtle: "rgba(34, 197, 94, 0.2)",
  warningSubtle: "rgba(245, 158, 11, 0.2)",
  infoSubtle: "rgba(59, 130, 246, 0.2)",
  /**
   * A sheet's backing. Android TV does not blur what is behind a BlurView, it
   * only tints it, so a sheet needs one of its own there.
   */
  surfaceTranslucent: "rgba(23, 23, 23, 0.9)",
} as const;
