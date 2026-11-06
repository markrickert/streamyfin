import { PixelRatio } from "react-native";
import { toImagePixels } from "./imagePixels";

afterEach(() => {
  jest.restoreAllMocks();
});

describe("toImagePixels", () => {
  test("scales a layout length by the screen density", () => {
    jest.spyOn(PixelRatio, "get").mockReturnValue(3);

    expect(toImagePixels(130)).toBe(390);
  });

  test("returns whole pixels on a fractional density", () => {
    jest.spyOn(PixelRatio, "get").mockReturnValue(2.625);

    expect(toImagePixels(411)).toBe(1079);
  });
});
