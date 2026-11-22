/**
 * Fails on a color literal in the Kotlin and Swift sources of `modules/` and
 * `targets/`: a hex number or string, `Color(red:)`, `Color.White`, `.white`.
 * Native code reads `Colors`, the palette that `scripts/native-palette.ts`
 * generates from `constants/Colors.ts`. Biome cannot parse either language, so
 * this is the native counterpart of `no-color-literal`. A line that must keep a
 * literal ends in a `color-literal-ok: <reason>` comment. See
 * docs/conventions/colors.md.
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const SKIPPED_DIRS = new Set(["build", "Pods", "node_modules", ".gradle"]);
const GENERATED_HEADER = "Generated from constants/Colors.ts";
const ESCAPE = "color-literal-ok:";

const NAMED =
  "white|black|gray|red|green|blue|orange|yellow|purple|pink|brown|cyan|mint|teal|indigo";

const COMMON = [
  /\b0x[0-9A-Fa-f]{6,8}\b/,
  /"#[0-9A-Fa-f]{3,8}"/,
  /\b(?:UI|CG)?Color\(\s*(?:red|white|gray|hue|\.sRGB|\.display|\d|$)/,
  /\bColors\.\w+\.(?:copy\(alpha|opacity\()/,
];
const KOTLIN = [
  ...COMMON,
  /\bColor\.(?!Transparent\b)[A-Z][A-Za-z]*/,
  /\bColor\.argb\(\s*\d/,
  /\bColor\.(?:rgb|valueOf|hsv|hsl)\(/,
  /\.toColorInt\(\)/,
];
const SWIFT = [
  ...COMMON,
  new RegExp(`\\b(?:UI)?Color\\.(?:${NAMED}|darkGray|lightGray)\\b`),
  /\.system(?:Red|Orange|Yellow|Green|Mint|Teal|Cyan|Blue|Indigo|Purple|Pink|Brown|Gray\d?|Fill|Background|GroupedBackground)\b/,
  /\b(?:UI|CG)?Color\.init\(/,
  /(?<![\w.])\.init\(\s*(?:red|white|gray)/,
  /\bUIColor\(displayP3Red/,
  new RegExp(`(?<![\\w.])\\.(?:${NAMED})\\b`),
];

export type ColorViolation = { file: string; line: number; text: string };

const blankBlockComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "));

export const findNativeColorLiterals = (
  file: string,
  source: string,
): ColorViolation[] => {
  const patterns = file.endsWith(".kt") ? KOTLIN : SWIFT;
  const violations: ColorViolation[] = [];
  blankBlockComments(source)
    .split("\n")
    .forEach((text, index) => {
      if (text.includes(ESCAPE)) return;
      const code = text.replace(/\/\/.*$/, "");
      if (patterns.some((pattern) => pattern.test(code))) {
        violations.push({ file, line: index + 1, text: text.trim() });
      }
    });
  return violations;
};

const sourcesUnder = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      return SKIPPED_DIRS.has(entry.name)
        ? []
        : sourcesUnder(path.join(dir, entry.name));
    }
    return /\.(kt|swift)$/.test(entry.name) ? [path.join(dir, entry.name)] : [];
  });

export const isGeneratedPalette = (source: string) =>
  source.slice(0, 200).includes(GENERATED_HEADER);

export const scanNativeSources = (): ColorViolation[] =>
  ["modules", "targets"]
    .flatMap((dir) => sourcesUnder(path.join(ROOT, dir)))
    .flatMap((file) => {
      const source = fs.readFileSync(file, "utf8");
      return isGeneratedPalette(source)
        ? []
        : findNativeColorLiterals(path.relative(ROOT, file), source);
    });

if (require.main === module) {
  const violations = scanNativeSources();
  for (const { file, line, text } of violations) {
    console.error(`${file}:${line}: ${text}`);
  }
  if (violations.length > 0) {
    console.error(
      `\n${violations.length} native color literal(s). Use Colors.<token>, see docs/conventions/colors.md.`,
    );
    process.exit(1);
  }
}
