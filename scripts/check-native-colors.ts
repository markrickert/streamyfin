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
const GENERATED = new Set(["Colors.kt", "Colors.swift"]);
const ESCAPE = "color-literal-ok:";

const NAMED =
  "white|black|gray|red|green|blue|orange|yellow|purple|pink|brown|cyan|mint|teal|indigo";

const COMMON = [
  /\b0x[0-9A-Fa-f]{6,8}\b/,
  /"#[0-9A-Fa-f]{6,8}"/,
  /\b(?:UI)?Color\(\s*(?:red|white|hue|\.sRGB|\.display|\d)/,
];
const KOTLIN = [
  ...COMMON,
  /\bColor\.(?!Transparent\b)[A-Z][A-Za-z]*/,
  /\bColor\.argb\(\s*\d/,
];
const SWIFT = [
  ...COMMON,
  new RegExp(`\\b(?:UI)?Color\\.(?:${NAMED})\\b`),
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
    const isSource = /\.(kt|swift)$/.test(entry.name);
    return isSource && !GENERATED.has(entry.name)
      ? [path.join(dir, entry.name)]
      : [];
  });

export const scanNativeSources = (): ColorViolation[] =>
  ["modules", "targets"]
    .flatMap((dir) => sourcesUnder(path.join(ROOT, dir)))
    .flatMap((file) =>
      findNativeColorLiterals(
        path.relative(ROOT, file),
        fs.readFileSync(file, "utf8"),
      ),
    );

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
