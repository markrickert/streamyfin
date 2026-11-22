import { Platform } from "react-native";
import { Colors } from "@/constants/Colors";

/**
 * The backing a TV sheet draws behind its content. Android TV does not blur
 * what is behind a BlurView, it only tints it, so without one the page shows
 * through the sheet. Apple TV really blurs: no backing, the sheet stays frosted
 * glass.
 */
export const tvSheetBacking = () =>
  Platform.OS === "android"
    ? { backgroundColor: Colors.surfaceTranslucent }
    : undefined;
