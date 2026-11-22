/**
 * Writes the palette of `constants/Colors.ts` as Kotlin and Swift, one copy
 * per native module that cannot import another's files, and as the Tailwind
 * config. Run `bun scripts/native-palette.ts` after changing a color.
 * `native-palette.test.ts` fails when a copy on disk drifts from this output.
 * See docs/conventions/colors.md.
 */
import fs from "node:fs";
import path from "node:path";
import { Colors } from "../constants/Colors";

const ROOT = path.resolve(__dirname, "..");
const HEADER =
  "Generated from constants/Colors.ts by scripts/native-palette.ts. Do not edit.";

type Rgba = { r: number; g: number; b: number; a: number };

const parse = (value: string): Rgba | null => {
  if (value === "transparent") return null;
  if (value.startsWith("#")) {
    const [r, g, b] = [1, 3, 5].map((i) =>
      Number.parseInt(value.slice(i, i + 2), 16),
    );
    return { r, g, b, a: 1 };
  }
  const match = /rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/.exec(value);
  if (!match) throw new Error(`Unsupported color "${value}"`);
  return {
    r: Number(match[1]),
    g: Number(match[2]),
    b: Number(match[3]),
    a: Number(match[4]),
  };
};

const byte = (n: number) => n.toString(16).toUpperCase().padStart(2, "0");

type Palette = Record<string, string>;

const tokensOf = (palette: Palette) =>
  Object.entries(palette).map(([name, value]) => ({
    name,
    rgba: parse(value),
  }));

const argb = ({ r, g, b, a }: Rgba) =>
  `0x${byte(Math.round(a * 255))}${byte(r)}${byte(g)}${byte(b)}`;

/**
 * `compose: false` is for a module with no Compose dependency, whose views
 * take `android.graphics.Color` Ints.
 */
export const renderKotlinPalette = (
  packageName: string,
  compose = true,
  palette: Palette = Colors,
) => {
  const lines = tokensOf(palette).map(({ name, rgba }) => {
    if (!compose) {
      return rgba
        ? `  const val ${name} = ${argb(rgba)}.toInt()`
        : `  const val ${name} = 0x00000000`;
    }
    return rgba
      ? `  val ${name} = Color(${argb(rgba)})`
      : `  val ${name} = Color.Transparent`;
  });
  return `// ${HEADER}
package ${packageName}
${compose ? "\nimport androidx.compose.ui.graphics.Color\n" : ""}
internal object Colors {
${lines.join("\n")}
}
`;
};

export const renderSwiftPalette = (palette: Palette = Colors) => {
  const lines = tokensOf(palette).map(({ name, rgba }) =>
    rgba
      ? `  static let ${name} = Color(.sRGB, red: ${rgba.r} / 255, green: ${rgba.g} / 255, blue: ${rgba.b} / 255, opacity: ${rgba.a})`
      : `  static let ${name} = Color.clear`,
  );
  return `// ${HEADER}
import SwiftUI

enum Colors {
${lines.join("\n")}
}
`;
};

const OPACITY_VARIANT = /^(white|black)\d+$/;
const kebab = (name: string) =>
  name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/**
 * The opacity variants (`white10`) are left out: Tailwind reaches them as
 * `white/10`.
 */
export const renderTailwindConfig = (palette: Palette = Colors) => {
  const lines = Object.entries(palette)
    .filter(([name]) => !OPACITY_VARIANT.test(name))
    .map(([name, value]) => {
      const key = kebab(name);
      return `      ${key.includes("-") ? `"${key}"` : key}: "${value}",`;
    });
  return `/** @type {import('tailwindcss').Config} */

// ${HEADER}
// The palette of constants/Colors.ts, by kebab-case name, and nothing else:
// a class naming any other color (\`bg-neutral-900\`) renders nothing.
// \`white/10\` and friends are Colors.white10, Tailwind's own opacity modifier.
module.exports = {
  darkMode: "class",
  content: ["./app/**/*.{js,jsx,ts,tsx}", "./components/**/*.{js,jsx,ts,tsx}"],
  theme: {
    colors: {
${lines.join("\n")}
    },
    extend: {},
  },
  plugins: [],
};
`;
};

const KOTLIN_ROOT = "src/main/java/expo/modules";

export const nativePaletteTargets = (
  palette: Palette = Colors,
): { path: string; content: string }[] => [
  ...[
    { module: "mpv-player", pkg: "mpvplayer", compose: true },
    { module: "hero-carousel", pkg: "herocarousel", compose: true },
    { module: "exoplayer-player", pkg: "exoplayerplayer", compose: false },
  ].map(({ module, pkg, compose }) => ({
    path: `modules/${module}/android/${KOTLIN_ROOT}/${pkg}/Colors.kt`,
    content: renderKotlinPalette(`expo.modules.${pkg}`, compose, palette),
  })),
  ...[
    "modules/mpv-player/ios",
    "modules/hero-carousel/ios",
    "modules/glass-poster/ios",
    "modules/tv-search/ios",
    "targets/StreamyfinDownloadActivity",
  ].map((dir) => ({
    path: `${dir}/Colors.swift`,
    content: renderSwiftPalette(palette),
  })),
  { path: "tailwind.config.js", content: renderTailwindConfig(palette) },
];

export const NATIVE_PALETTE_TARGETS = nativePaletteTargets();

if (require.main === module) {
  for (const { path: file, content } of NATIVE_PALETTE_TARGETS) {
    const target = path.join(ROOT, file);
    if (fs.existsSync(target) && fs.readFileSync(target, "utf8") === content) {
      continue;
    }
    fs.writeFileSync(target, content);
  }
}
