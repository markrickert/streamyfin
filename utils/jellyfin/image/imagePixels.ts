import { PixelRatio } from "react-native";

/**
 * Physical pixels a layout length covers on this screen.
 *
 * Layout is measured in density independent points and the server sizes
 * images in pixels. Every size sent to the server goes through here, or a 3x
 * screen stretches the image over three times the pixels it was asked for.
 */
export const toImagePixels = (layoutSize: number) =>
  PixelRatio.getPixelSizeForLayoutSize(layoutSize);
