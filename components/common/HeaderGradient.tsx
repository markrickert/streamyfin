import { LinearGradient } from "expo-linear-gradient";
import { StyleSheet } from "react-native";
import { Colors } from "@/constants/Colors";

/**
 * Scrim rendered via the `headerBackground` screen option, under a
 * `headerTransparent` header. Fades from dark at the status bar to fully
 * transparent at the bottom edge of the navigation bar, keeping the title
 * readable while content scrolls beneath it.
 */
export const HeaderGradient = () => (
  <LinearGradient
    colors={[Colors.black, Colors.black80, Colors.transparent]}
    locations={[0, 0.7, 1]}
    style={StyleSheet.absoluteFill}
    pointerEvents='none'
  />
);
