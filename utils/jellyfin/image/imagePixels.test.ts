import { PixelRatio } from "react-native";
import {
  CARD_IMAGE_WIDTH_STEP_PX,
  MAX_CARD_IMAGE_WIDTH_PX,
} from "@/constants/Images";
import { cardImageWidth, toImagePixels } from "./imagePixels";

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

describe("cardImageWidth", () => {
  test("rounds the drawn size up to the next step", () => {
    jest.spyOn(PixelRatio, "get").mockReturnValue(1);

    expect(cardImageWidth(189)).toBe(CARD_IMAGE_WIDTH_STEP_PX * 2);
  });

  test("never requests past the card artwork cap", () => {
    jest.spyOn(PixelRatio, "get").mockReturnValue(3);

    expect(cardImageWidth(600)).toBe(MAX_CARD_IMAGE_WIDTH_PX);
  });
});
