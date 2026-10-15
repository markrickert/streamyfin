import { tvImageMemoryCacheBytes } from "./Images";

describe("tvImageMemoryCacheBytes", () => {
  test("holds 16 MB of decoded artwork on a 1080p screen", () => {
    expect(tvImageMemoryCacheBytes(1920)).toBe(16 * 1024 * 1024);
  });

  // Card artwork follows the pixel density, so the same cards decode to four
  // times the bytes on a 4K screen; a fixed cap would hold a quarter screen.
  test("grows with the pixels a 4K screen asks for", () => {
    expect(tvImageMemoryCacheBytes(3840)).toBe(64 * 1024 * 1024);
  });
});
