import { Colors } from "./Colors";

const tailwind = require("../tailwind.config.js");

const OPACITY_VARIANT = /^(white|black)(\d+)$/;
const kebab = (name: string) =>
  name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

const alphaOf = (rgba: string) =>
  Number(/rgba\(.*,\s*([\d.]+)\)/.exec(rgba)?.[1]);
const channelsOf = (value: string) =>
  value.startsWith("#")
    ? [1, 3, 5].map((i) => Number.parseInt(value.slice(i, i + 2), 16))
    : (/rgba\((\d+),\s*(\d+),\s*(\d+)/.exec(value) ?? []).slice(1).map(Number);

describe("tailwind palette", () => {
  const palette: Record<string, string> = tailwind.theme.colors;

  it("holds every named color of Colors, by kebab-case name", () => {
    for (const [name, value] of Object.entries(Colors)) {
      if (OPACITY_VARIANT.test(name)) continue;
      expect(palette[kebab(name)]).toBe(value);
    }
  });

  it("holds nothing that Colors does not", () => {
    const named = Object.keys(Colors)
      .filter((name) => !OPACITY_VARIANT.test(name))
      .map(kebab);
    expect(Object.keys(palette).sort()).toEqual(named.sort());
  });

  it("reaches each opacity variant of Colors as the white or black class with that opacity", () => {
    for (const [name, value] of Object.entries(Colors)) {
      const match = OPACITY_VARIANT.exec(name);
      if (!match) continue;
      const [, base, percent] = match;
      expect(channelsOf(value)).toEqual(channelsOf(palette[base]));
      expect(alphaOf(value) * 100).toBeCloseTo(Number(percent), 5);
    }
  });
});
