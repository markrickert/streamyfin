/**
 * compare.ts scoring policy, on small generated images: what counts as blank, as drift,
 * as a color shift, and when a screen beats its noise floor.
 */
import { PNG } from "pngjs";
import {
  applyMasks,
  byDrift,
  colorShifts,
  drift,
  isBlank,
  isChanged,
  MIN_DRIFT_PERCENT,
  MIN_SHIFTED_PERCENT,
  NOISE_MARGIN,
  type Row,
  SHIFT_MIN_PIXELS,
  shifted,
} from "./compare";

type Rgb = [number, number, number];

function image(width: number, height: number, color: Rgb): PNG {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) {
    png.data.set([...color, 255], i * 4);
  }
  return png;
}

/** Paints the last `count` pixels, so the first pixel keeps the background isBlank compares against. */
function paint(png: PNG, count: number, color: Rgb): PNG {
  const pixels = png.width * png.height;
  for (let i = pixels - count; i < pixels; i++)
    png.data.set([...color, 255], i * 4);
  return png;
}

const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];
const RED: Rgb = [255, 0, 0];

const scores = (overrides: Partial<Row> = {}) => ({
  percent: 0,
  floor: 0,
  shifted: 0,
  shiftFloor: 0,
  informational: false,
  ...overrides,
});

describe("isBlank", () => {
  it("calls one flat color a capture failure", () => {
    expect(isBlank(image(100, 100, BLACK))).toBe(true);
  });
  it("tolerates a stray pixel under the blank share", () => {
    expect(isBlank(paint(image(100, 100, BLACK), 10, WHITE))).toBe(true);
  });
  it("calls a frame with real content a screen", () => {
    expect(isBlank(paint(image(100, 100, BLACK), 11, WHITE))).toBe(false);
  });
});

describe("applyMasks", () => {
  it("paints a fractional region black on any image size", () => {
    const png = applyMasks(image(10, 10, WHITE), [[0.5, 0, 0.5, 0.1]]);
    const at = (x: number, y: number) => [
      ...png.data.subarray((y * 10 + x) * 4, (y * 10 + x) * 4 + 3),
    ];
    expect(at(4, 0)).toEqual(WHITE);
    expect(at(5, 0)).toEqual(BLACK);
    expect(at(9, 0)).toEqual(BLACK);
    expect(at(5, 1)).toEqual(WHITE);
  });
});

describe("drift", () => {
  it("is zero for identical images", () => {
    expect(drift(image(10, 10, WHITE), image(10, 10, WHITE))).toBe(0);
  });
  it("is the share of pixels that differ", () => {
    const after = paint(image(10, 10, WHITE), 25, BLACK);
    expect(drift(image(10, 10, WHITE), after)).toBe(25);
  });
  it("is null when the sizes differ", () => {
    expect(drift(image(10, 10, WHITE), image(10, 12, WHITE))).toBeNull();
  });
});

describe("shifted", () => {
  // The palette-refactor case: pixelmatch scores white to #ECEDEE as no change at all.
  it("catches an even shift that drift ignores", () => {
    const before = image(10, 10, WHITE);
    const after = image(10, 10, [0xec, 0xed, 0xee]);
    expect(drift(before, after)).toBe(0);
    expect(shifted(before, after)).toBe(100);
  });
  it("ignores a channel move under the minimum delta", () => {
    expect(shifted(image(10, 10, WHITE), image(10, 10, [250, 250, 250]))).toBe(
      0,
    );
  });
});

describe("colorShifts", () => {
  it("lists the pairs that repeat often enough, most frequent first", () => {
    const after = paint(
      paint(image(20, 20, WHITE), SHIFT_MIN_PIXELS * 3, BLACK),
      SHIFT_MIN_PIXELS,
      RED,
    );
    expect(colorShifts(image(20, 20, WHITE), after)).toBe(
      `\`#FFFFFF → #000000\` (${SHIFT_MIN_PIXELS * 2} px)<br>\`#FFFFFF → #FF0000\` (${SHIFT_MIN_PIXELS} px)`,
    );
  });
  it("leaves out pairs too rare to be a token change", () => {
    const after = paint(image(20, 20, WHITE), SHIFT_MIN_PIXELS - 1, BLACK);
    expect(colorShifts(image(20, 20, WHITE), after)).toBe("");
  });
});

describe("isChanged", () => {
  it("leaves drift under the minimum unchanged, even with no noise floor", () => {
    expect(isChanged(scores({ percent: MIN_DRIFT_PERCENT, floor: null }))).toBe(
      false,
    );
  });
  it("flags drift that clears the minimum and the noise margin", () => {
    expect(isChanged(scores({ percent: 1, floor: 0.4 }))).toBe(true);
  });
  it("leaves drift within the noise margin unchanged", () => {
    expect(isChanged(scores({ percent: 1, floor: 1 / NOISE_MARGIN }))).toBe(
      false,
    );
  });
  it("flags a color shift above the noise margin with no drift", () => {
    expect(
      isChanged(scores({ shifted: MIN_SHIFTED_PERCENT * 10, shiftFloor: 0 })),
    ).toBe(true);
  });
  it("leaves a color shift within the noise margin unchanged", () => {
    expect(isChanged(scores({ shifted: 1, shiftFloor: 1 }))).toBe(false);
  });
  it("flags a size change", () => {
    expect(isChanged(scores({ percent: null, shifted: null }))).toBe(true);
  });
  it("never flags an informational screen", () => {
    expect(
      isChanged(scores({ percent: null, shifted: null, informational: true })),
    ).toBe(false);
  });
});

describe("byDrift", () => {
  const row = (name: string, percent: number | null, shiftedBy = 0): Row => ({
    ...scores({ percent, shifted: shiftedBy }),
    name,
    flagged: false,
    shifts: "",
  });
  it("ranks a size change first, then the larger of drift and shift", () => {
    const rows = [
      row("small", 1),
      row("shift", 0.5, 30),
      row("resized", null),
      row("drift", 20),
    ].sort(byDrift);
    expect(rows.map((r) => r.name)).toEqual([
      "resized",
      "shift",
      "drift",
      "small",
    ]);
  });
});
