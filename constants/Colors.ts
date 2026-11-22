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

/**
 * Decorative gradient pairs (from, to) for the TV server icons, picked by a
 * hash of the server URL. Data, not UI colors: they are not part of the palette.
 */
export const SERVER_GRADIENT_COLORS: [string, string][] = [
  ["#00D4FF", "#0066FF"], // Cyan to Blue
  ["#FF00E5", "#7B00FF"], // Magenta to Purple
  ["#00FF94", "#00B4D8"], // Neon Green to Cyan
  ["#FF6B35", "#F72585"], // Orange to Pink
  ["#4CC9F0", "#7209B7"], // Sky Blue to Violet
  ["#06D6A0", "#118AB2"], // Mint to Ocean Blue
  ["#FFD60A", "#FF006E"], // Yellow to Hot Pink
  ["#8338EC", "#3A86FF"], // Purple to Blue
  ["#FB5607", "#FFBE0B"], // Orange to Gold
  ["#00F5D4", "#00BBF9"], // Aqua to Azure
  ["#F15BB5", "#9B5DE5"], // Pink to Lavender
  ["#00C49A", "#00509D"], // Teal to Navy
  ["#E63946", "#F4A261"], // Red to Peach
  ["#2EC4B6", "#011627"], // Turquoise to Dark Blue
  ["#FF0099", "#493240"], // Hot Pink to Plum
  ["#11998E", "#38EF7D"], // Teal to Lime
  ["#FC466B", "#3F5EFB"], // Pink to Indigo
  ["#C471ED", "#12C2E9"], // Orchid to Sky
  ["#F857A6", "#FF5858"], // Pink to Coral
  ["#00B09B", "#96C93D"], // Emerald to Lime
  ["#7F00FF", "#E100FF"], // Violet to Magenta
  ["#1FA2FF", "#12D8FA"], // Blue to Cyan
  ["#F09819", "#EDDE5D"], // Orange to Yellow
  ["#FF416C", "#FF4B2B"], // Pink to Red Orange
  ["#654EA3", "#EAAFC8"], // Purple to Rose
  ["#00C6FF", "#0072FF"], // Light Blue to Blue
  ["#F7971E", "#FFD200"], // Orange to Gold
  ["#56AB2F", "#A8E063"], // Green to Lime
  ["#DA22FF", "#9733EE"], // Magenta to Purple
  ["#02AAB0", "#00CDAC"], // Teal variations
  ["#ED213A", "#93291E"], // Red to Dark Red
  ["#FDC830", "#F37335"], // Yellow to Orange
  ["#00B4DB", "#0083B0"], // Ocean Blue
  ["#C33764", "#1D2671"], // Berry to Navy
  ["#E55D87", "#5FC3E4"], // Pink to Sky Blue
  ["#403B4A", "#E7E9BB"], // Dark to Cream
  ["#F2709C", "#FF9472"], // Rose to Peach
  ["#1D976C", "#93F9B9"], // Forest to Mint
  ["#CC2B5E", "#753A88"], // Crimson to Purple
  ["#42275A", "#734B6D"], // Plum shades
  ["#BDC3C7", "#2C3E50"], // Silver to Slate
  ["#DE6262", "#FFB88C"], // Salmon to Apricot
  ["#06BEB6", "#48B1BF"], // Teal shades
  ["#EB3349", "#F45C43"], // Red to Orange Red
  ["#DD5E89", "#F7BB97"], // Pink to Tan
  ["#56CCF2", "#2F80ED"], // Sky to Blue
  ["#007991", "#78FFD6"], // Deep Teal to Mint
  ["#C6FFDD", "#FBD786"], // Mint to Yellow
  ["#F953C6", "#B91D73"], // Pink to Magenta
  ["#B24592", "#F15F79"], // Purple to Coral
];

/**
 * The subtitle colors a user can pick. Saved in settings by value, so the
 * values must never change.
 */
export const SubtitleColors = {
  white: "#FFFFFF",
  yellow: "#FFFF00",
  cyan: "#00FFFF",
  green: "#00FF00",
  magenta: "#FF00FF",
  red: "#FF0000",
} as const;

/**
 * A clear background in the #AARRGGBB form the ExoPlayer subtitle view parses:
 * Android's Color.parseColor does not know "transparent". Data, not a palette color.
 */
export const EXOPLAYER_CLEAR_COLOR = "#00000000";
