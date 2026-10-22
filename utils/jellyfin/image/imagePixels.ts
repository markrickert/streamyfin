import { PixelRatio } from "react-native";
import {
  CARD_IMAGE_WIDTH_STEP_PX,
  MAX_CARD_IMAGE_WIDTH_PX,
} from "@/constants/Images";

/**
 * Physical pixels a layout length covers on this screen.
 *
 * Layout is measured in density independent points and the server sizes
 * images in pixels. Every size sent to the server goes through here, or a 3x
 * screen stretches the image over three times the pixels it was asked for.
 */
export const toImagePixels = (layoutSize: number) =>
  PixelRatio.getPixelSizeForLayoutSize(layoutSize);

/**
 * Pixel width to request artwork at for a card this many layout points wide:
 * what the screen draws, rounded up to the next step so cards of nearly the
 * same width share one image.
 */
export const cardImageWidth = (cardWidth: number) =>
  Math.min(
    Math.ceil(toImagePixels(cardWidth) / CARD_IMAGE_WIDTH_STEP_PX) *
      CARD_IMAGE_WIDTH_STEP_PX,
    MAX_CARD_IMAGE_WIDTH_PX,
  );
