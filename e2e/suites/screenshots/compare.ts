#!/usr/bin/env bun
/**
 * Pairs the screenshots of a "before" and an "after" run by file name, diffs each pair, and
 * writes one before | after | diff image per screen plus a summary.md ranked by drift and a
 * contact-sheet.png stacking every composite under a label strip, in summary order.
 *
 *   bun e2e/suites/screenshots/compare.ts --before <dir> --after <dir> --out <dir> [--noise <dir>] [--masks <file.json>] [--evidence <dir>]
 *
 * --noise is a second run of the "before" build. Posters, blurhash and decode timing differ
 * between two runs of the same build, so the drift of before vs noise is the floor a screen
 * must clear before its change counts as color drift. Without it every difference is reported.
 *
 * --evidence copies the composite of every changed screen, and summary.md, into one folder: the set
 * to attach to a pull request.
 */
import fs from "node:fs";
import path from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

/** pixelmatch color distance, 0 to 1: below it two pixels count as the same. */
const PIXEL_THRESHOLD = 0.1;
/** A screen whose drift is under this share of its pixels, and under the noise floor, is "unchanged". */
export const MIN_DRIFT_PERCENT = 0.05;
/**
 * pixelmatch ignores a small, even shift such as white to #ECEDEE across all the text of a screen,
 * which is the change a palette refactor makes. A screen also counts as changed when this share of
 * its pixels moved by SHIFT_MIN_CHANNEL_DELTA or more, and more than twice the noise floor's share.
 */
export const MIN_SHIFTED_PERCENT = 0.02;
/** Drift must exceed the noise floor by this factor to be flagged. */
export const NOISE_MARGIN = 2;
/** A pixel pair counts toward a color shift only when some channel moved at least this much. */
const SHIFT_MIN_CHANNEL_DELTA = 12;
/** A shift needs this many pixels: text edges make a long tail of one-off pairs. */
export const SHIFT_MIN_PIXELS = 40;
const SHIFT_TOP = 3;
const COMPOSITE_SCALE = 2;
const GAP = 16;

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`Expected --name value pairs, got ${key}`);
    }
    args[key.slice(2)] = value;
  }
  return args;
}

/** Every png under a run folder, keyed by its file name without extension. */
function collect(dir: string): Map<string, string> {
  const found = new Map<string, string>();
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".png") && full.includes("takeScreenshot")) {
        found.set(entry.name.replace(/\.png$/, ""), full);
      }
    }
  };
  walk(dir);
  return found;
}

/** Per screen, regions as [x, y, width, height] fractions of the image, painted black before diffing. */
export type Masks = Record<string, [number, number, number, number][]>;

/**
 * Screens print things that must not reach a PR (the session token) or that always differ between
 * two builds (the build's commit SHA). A fraction survives a different device size.
 */
export function applyMasks(image: PNG, regions: Masks[string] = []): PNG {
  for (const [fx, fy, fw, fh] of regions) {
    const x0 = Math.floor(fx * image.width);
    const y0 = Math.floor(fy * image.height);
    const x1 = Math.min(image.width, Math.ceil((fx + fw) * image.width));
    const y1 = Math.min(image.height, Math.ceil((fy + fh) * image.height));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * image.width + x) * 4;
        image.data[i] = 0;
        image.data[i + 1] = 0;
        image.data[i + 2] = 0;
        image.data[i + 3] = 255;
      }
    }
  }
  return image;
}

/**
 * A screenshot that is one flat color is a capture failure (a blank frame, an emulator without a
 * GPU), not a screen: the comparison would call it unchanged.
 */
const BLANK_SHARE = 0.999;
export function isBlank(image: PNG): boolean {
  const { data } = image;
  const pixels = data.length / 4;
  const allowedOther = Math.floor(pixels * (1 - BLANK_SHARE));
  let other = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (
      data[i] !== data[0] ||
      data[i + 1] !== data[1] ||
      data[i + 2] !== data[2]
    ) {
      other++;
      if (other > allowedOther) return false;
    }
  }
  return true;
}

/** Differing pixels as a percentage of the image, or null when the sizes differ. */
export function drift(a: PNG, b: PNG, output?: PNG): number | null {
  if (a.width !== b.width || a.height !== b.height) return null;
  const changed = pixelmatch(
    a.data,
    b.data,
    output?.data ?? null,
    a.width,
    a.height,
    {
      threshold: PIXEL_THRESHOLD,
      includeAA: false,
    },
  );
  return (changed / (a.width * a.height)) * 100;
}

/** Share of pixels with a channel that moved by SHIFT_MIN_CHANNEL_DELTA or more, or null when the sizes differ. */
export function shifted(a: PNG, b: PNG): number | null {
  if (a.width !== b.width || a.height !== b.height) return null;
  let count = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const delta = Math.max(
      Math.abs(a.data[i] - b.data[i]),
      Math.abs(a.data[i + 1] - b.data[i + 1]),
      Math.abs(a.data[i + 2] - b.data[i + 2]),
    );
    if (delta >= SHIFT_MIN_CHANNEL_DELTA) count++;
  }
  return (count / (a.width * a.height)) * 100;
}

const hex = (data: Buffer, i: number) =>
  `#${[0, 1, 2].map((c) => data[i + c].toString(16).padStart(2, "0")).join("")}`.toUpperCase();

/**
 * The exact colors that became other colors, most frequent first. Flat fills (a badge, a link, a
 * button) repeat the same pair thousands of times, so the top pairs read as the token change
 * itself; gradients and text edges scatter into pairs too rare to list.
 */
export function colorShifts(a: PNG, b: PNG): string {
  if (a.width !== b.width || a.height !== b.height) return "";
  const counts = new Map<string, number>();
  for (let i = 0; i < a.data.length; i += 4) {
    const delta = Math.max(
      Math.abs(a.data[i] - b.data[i]),
      Math.abs(a.data[i + 1] - b.data[i + 1]),
      Math.abs(a.data[i + 2] - b.data[i + 2]),
    );
    if (delta < SHIFT_MIN_CHANNEL_DELTA) continue;
    const key = `${hex(a.data, i)} → ${hex(b.data, i)}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, n]) => n >= SHIFT_MIN_PIXELS)
    .sort((x, y) => y[1] - x[1])
    .slice(0, SHIFT_TOP)
    .map(([pair, n]) => `\`${pair}\` (${n} px)`)
    .join("<br>");
}

function downscale(src: PNG, factor: number): PNG {
  const width = Math.floor(src.width / factor);
  const height = Math.floor(src.height / factor);
  const out = new PNG({ width, height });
  const area = factor * factor;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let dy = 0; dy < factor; dy++) {
        for (let dx = 0; dx < factor; dx++) {
          const i = ((y * factor + dy) * src.width + (x * factor + dx)) * 4;
          r += src.data[i];
          g += src.data[i + 1];
          b += src.data[i + 2];
          a += src.data[i + 3];
        }
      }
      const o = (y * width + x) * 4;
      out.data[o] = r / area;
      out.data[o + 1] = g / area;
      out.data[o + 2] = b / area;
      out.data[o + 3] = a / area;
    }
  }
  return out;
}

function composite(panels: PNG[]): PNG {
  const height = Math.max(...panels.map((p) => p.height));
  const width =
    panels.reduce((sum, p) => sum + p.width, 0) + GAP * (panels.length - 1);
  const out = new PNG({ width, height });
  out.data.fill(0);
  let left = 0;
  for (const panel of panels) {
    PNG.bitblt(panel, out, 0, 0, panel.width, panel.height, left, 0);
    left += panel.width + GAP;
  }
  return out;
}

/** A composite's label strip: a 5x7 bitmap font at FONT_SCALE plus padding, on a red or gray fill. */
const FONT_SCALE = 2;
export const STRIP_HEIGHT = 24;
export const SHEET_GAP = 16;
export const STRIP_CHANGED: [number, number, number] = [158, 32, 32];
export const STRIP_UNCHANGED: [number, number, number] = [40, 40, 40];

/** 5 columns x 7 rows per glyph, '#' filled; uppercase only, the label is uppercased on draw. */
const FONT_5X7: Record<string, string[]> = {
  " ": [".....", ".....", ".....", ".....", ".....", ".....", "....."],
  "0": [".###.", "#...#", "#..##", "#.#.#", "##..#", "#...#", ".###."],
  "1": ["..#..", ".##..", "..#..", "..#..", "..#..", "..#..", ".###."],
  "2": [".###.", "#...#", "....#", "..##.", ".#...", "#....", "#####"],
  "3": [".###.", "#...#", "....#", "..##.", "....#", "#...#", ".###."],
  "4": ["...#.", "..##.", ".#.#.", "#..#.", "#####", "...#.", "...#."],
  "5": ["#####", "#....", "####.", "....#", "....#", "#...#", ".###."],
  "6": [".###.", "#...#", "#....", "####.", "#...#", "#...#", ".###."],
  "7": ["#####", "....#", "...#.", "..#..", ".#...", ".#...", ".#..."],
  "8": [".###.", "#...#", "#...#", ".###.", "#...#", "#...#", ".###."],
  "9": [".###.", "#...#", "#...#", ".####", "....#", "#...#", ".###."],
  A: [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  B: ["####.", "#...#", "#...#", "####.", "#...#", "#...#", "####."],
  C: [".###.", "#...#", "#....", "#....", "#....", "#...#", ".###."],
  D: ["####.", "#...#", "#...#", "#...#", "#...#", "#...#", "####."],
  E: ["#####", "#....", "#....", "####.", "#....", "#....", "#####"],
  F: ["#####", "#....", "#....", "####.", "#....", "#....", "#...."],
  G: [".###.", "#...#", "#....", "#.###", "#...#", "#...#", ".###."],
  H: ["#...#", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  I: [".###.", "..#..", "..#..", "..#..", "..#..", "..#..", ".###."],
  J: ["..##.", "...#.", "...#.", "...#.", "...#.", "#..#.", ".##.."],
  K: ["#...#", "#..#.", "#.#..", "##...", "#.#..", "#..#.", "#...#"],
  L: ["#....", "#....", "#....", "#....", "#....", "#....", "#####"],
  M: ["#...#", "##.##", "#.#.#", "#.#.#", "#...#", "#...#", "#...#"],
  N: ["#...#", "##..#", "#.#.#", "#..##", "#...#", "#...#", "#...#"],
  O: [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  P: ["####.", "#...#", "#...#", "####.", "#....", "#....", "#...."],
  Q: [".###.", "#...#", "#...#", "#...#", "#.#.#", "#..#.", ".##.#"],
  R: ["####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"],
  S: [".###.", "#...#", "#....", ".###.", "....#", "#...#", ".###."],
  T: ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
  U: ["#...#", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  V: ["#...#", "#...#", "#...#", "#...#", "#...#", ".#.#.", "..#.."],
  W: ["#...#", "#...#", "#...#", "#.#.#", "#.#.#", "##.##", ".#.#."],
  X: ["#...#", "#...#", ".#.#.", "..#..", ".#.#.", "#...#", "#...#"],
  Y: ["#...#", "#...#", ".#.#.", "..#..", "..#..", "..#..", "..#.."],
  Z: ["#####", "....#", "...#.", "..#..", ".#...", "#....", "#####"],
  "-": [".....", ".....", ".....", "#####", ".....", ".....", "....."],
  ".": [".....", ".....", ".....", ".....", ".....", ".##..", ".##.."],
  "%": ["##..#", "##.#.", "...#.", "..#..", ".#...", "#.##.", "#..##"],
  "/": ["....#", "...#.", "...#.", "..#..", ".#...", ".#...", "#...."],
  ":": [".....", ".##..", ".##..", ".....", ".##..", ".##..", "....."],
  _: [".....", ".....", ".....", ".....", ".....", ".....", "#####"],
};

const WHITE: [number, number, number] = [255, 255, 255];

function fillRect(
  out: PNG,
  x0: number,
  y0: number,
  width: number,
  height: number,
  color: [number, number, number],
): void {
  for (let y = y0; y < y0 + height && y < out.height; y++) {
    for (let x = x0; x < x0 + width && x < out.width; x++) {
      const i = (y * out.width + x) * 4;
      out.data[i] = color[0];
      out.data[i + 1] = color[1];
      out.data[i + 2] = color[2];
      out.data[i + 3] = 255;
    }
  }
}

/** Draws text in white at FONT_SCALE; a char with no glyph advances blank. */
function drawText(out: PNG, text: string, x0: number, y0: number): void {
  let left = x0;
  for (const char of text.toUpperCase()) {
    const glyph = FONT_5X7[char];
    if (glyph) {
      for (let row = 0; row < 7; row++) {
        for (let col = 0; col < 5; col++) {
          if (glyph[row][col] !== "#") continue;
          fillRect(
            out,
            left + col * FONT_SCALE,
            y0 + row * FONT_SCALE,
            FONT_SCALE,
            FONT_SCALE,
            WHITE,
          );
        }
      }
    }
    left += 6 * FONT_SCALE;
  }
}

/** What one screen's strip reads: name, verdict, drift and floor, like summary.md. */
export function sheetLabel(row: Row): string {
  const verdict = row.flagged
    ? "CHANGED"
    : row.informational
      ? "informational"
      : "unchanged";
  const drift =
    row.percent === null ? "size differs" : `${row.percent.toFixed(2)}%`;
  const floor = row.floor === null ? "n/a" : `${row.floor.toFixed(2)}%`;
  return `${row.name}  ${verdict}  drift ${drift}  floor ${floor}`;
}

export interface SheetEntry {
  label: string;
  /** Flagged rows get a red strip, the rest dark gray. */
  changed: boolean;
  /** The before|after|diff composite already written per screen. */
  image: PNG;
}

/**
 * One column of labeled composites: strip, composite, gap, opaque black behind
 * (a browser shows alpha as a checkerboard). Undefined with nothing to stack.
 */
export function contactSheet(entries: SheetEntry[]): PNG | undefined {
  if (entries.length === 0) return undefined;
  const width = Math.max(...entries.map((e) => e.image.width));
  const height =
    entries.length * STRIP_HEIGHT +
    entries.reduce((sum, e) => sum + e.image.height, 0) +
    SHEET_GAP * (entries.length - 1);
  const sheet = new PNG({ width, height });
  for (let i = 3; i < sheet.data.length; i += 4) sheet.data[i] = 255;
  let top = 0;
  for (const { label, changed, image } of entries) {
    fillRect(
      sheet,
      0,
      top,
      width,
      STRIP_HEIGHT,
      changed ? STRIP_CHANGED : STRIP_UNCHANGED,
    );
    drawText(
      sheet,
      label,
      FONT_SCALE * 2,
      top + Math.floor((STRIP_HEIGHT - 7 * FONT_SCALE) / 2),
    );
    const imageTop = top + STRIP_HEIGHT;
    PNG.bitblt(image, sheet, 0, 0, image.width, image.height, 0, imageTop);
    // A composite's panel gaps are transparent; over the sheet they must stay black.
    for (let y = imageTop; y < imageTop + image.height; y++) {
      for (let x = 0; x < image.width; x++) {
        sheet.data[(y * width + x) * 4 + 3] = 255;
      }
    }
    top = imageTop + image.height + SHEET_GAP;
  }
  return sheet;
}

export type Row = {
  name: string;
  percent: number | null;
  floor: number | null;
  shifted: number | null;
  shiftFloor: number | null;
  informational: boolean;
  flagged: boolean;
  shifts: string;
};

/**
 * A screen counts as changed when its size differs, or when its drift or its color shift
 * clears both its own minimum and NOISE_MARGIN times the noise floor. An informational
 * screen is reported but never counts.
 */
export function isChanged(
  r: Pick<
    Row,
    "percent" | "floor" | "shifted" | "shiftFloor" | "informational"
  >,
): boolean {
  if (r.informational) return false;
  if (r.percent === null) return true;
  const driftFlagged =
    r.percent > MIN_DRIFT_PERCENT &&
    (r.floor === null || r.percent > r.floor * NOISE_MARGIN);
  const shiftFlagged =
    r.shifted !== null &&
    r.shifted > MIN_SHIFTED_PERCENT &&
    (r.shiftFloor === null || r.shifted > r.shiftFloor * NOISE_MARGIN);
  return driftFlagged || shiftFlagged;
}

/** Largest drift first; a size change outranks any drift. */
export const byDrift = (x: Row, y: Row) => weight(y) - weight(x);
const weight = (r: Row) =>
  r.percent === null ? 100 : Math.max(r.percent, r.shifted ?? 0);

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  for (const required of ["before", "after", "out"]) {
    if (!args[required]) throw new Error(`Missing --${required}`);
  }

  const before = collect(args.before);
  const after = collect(args.after);
  const noise = args.noise ? collect(args.noise) : new Map<string, string>();
  const masks: Masks = args.masks
    ? JSON.parse(fs.readFileSync(args.masks, "utf8"))
    : {};
  fs.mkdirSync(args.out, { recursive: true });
  const blank: string[] = [];
  const read = (file: string, regions: Masks[string] = []) => {
    const image = PNG.sync.read(fs.readFileSync(file));
    if (isBlank(image)) blank.push(file);
    return applyMasks(image, [...(masks["*"] ?? []), ...regions]);
  };

  const rows: Row[] = [];
  const onlyOne: string[] = [];

  for (const name of [...before.keys()].sort()) {
    const afterFile = after.get(name);
    if (!afterFile) {
      onlyOne.push(`${name} (no after shot)`);
      continue;
    }
    const a = read(before.get(name) as string, masks[name]);
    const b = read(afterFile, masks[name]);
    const diff = new PNG({ width: a.width, height: a.height });
    const percent = drift(a, b, diff);
    const noiseFile = noise.get(name);
    const n = noiseFile ? read(noiseFile, masks[name]) : null;
    const floor = n ? drift(a, n) : null;
    const shiftedPercent = shifted(a, b);
    const shiftFloor = n ? shifted(a, n) : null;
    const informational = name === "10-seerr-discover";
    const flagged = isChanged({
      percent,
      floor,
      shifted: shiftedPercent,
      shiftFloor,
      informational,
    });
    rows.push({
      name,
      percent,
      floor,
      shifted: shiftedPercent,
      shiftFloor,
      informational,
      flagged,
      shifts: flagged ? colorShifts(a, b) : "",
    });
    if (percent !== null) {
      const panels = [a, b, diff].map((p) => downscale(p, COMPOSITE_SCALE));
      fs.writeFileSync(
        path.join(args.out, `${name}.png`),
        PNG.sync.write(composite(panels)),
      );
    }
  }
  for (const name of after.keys()) {
    if (!before.has(name)) onlyOne.push(`${name} (no before shot)`);
  }

  rows.sort(byDrift);
  const fmt = (n: number | null) =>
    n === null ? "size differs" : `${n.toFixed(2)}%`;
  const lines = [
    "| Screen | Drift | Noise floor | Shifted | Shift floor | Verdict | Main color shifts |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map(
      (r) =>
        `| ${r.name} | ${fmt(r.percent)} | ${r.floor === null ? "n/a" : fmt(r.floor)} | ${fmt(r.shifted)} | ${r.shiftFloor === null ? "n/a" : fmt(r.shiftFloor)} | ${r.informational ? "informational" : r.flagged ? "**changed**" : "unchanged"} | ${r.shifts} |`,
    ),
  ];
  if (onlyOne.length) lines.push("", `Unpaired: ${onlyOne.join(", ")}`);
  fs.writeFileSync(path.join(args.out, "summary.md"), `${lines.join("\n")}\n`);
  console.log(lines.join("\n"));

  // The browser view of the comparison: every composite under a label strip,
  // in the summary's order. A row with a size change wrote no composite, so it
  // has no strip either.
  const entries: SheetEntry[] = rows.flatMap((row) => {
    const file = path.join(args.out, `${row.name}.png`);
    if (!fs.existsSync(file)) return [];
    return [
      {
        label: sheetLabel(row),
        changed: row.flagged,
        image: PNG.sync.read(fs.readFileSync(file)),
      },
    ];
  });
  const sheet = contactSheet(entries);
  if (sheet)
    fs.writeFileSync(
      path.join(args.out, "contact-sheet.png"),
      PNG.sync.write(sheet),
    );

  if (args.evidence) {
    fs.mkdirSync(args.evidence, { recursive: true });
    for (const row of rows.filter((r) => r.flagged)) {
      const composite = path.join(args.out, `${row.name}.png`);
      if (fs.existsSync(composite)) {
        fs.copyFileSync(composite, path.join(args.evidence, `${row.name}.png`));
      }
    }
    fs.copyFileSync(
      path.join(args.out, "summary.md"),
      path.join(args.evidence, "summary.md"),
    );
  }

  if (blank.length) {
    console.error(
      `\nBlank screenshots, a capture failure, not a result:\n${blank.map((f) => `  ${f}`).join("\n")}`,
    );
    process.exitCode = 3;
  }
}
