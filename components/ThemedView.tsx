import { View, type ViewProps } from "react-native";
import { Colors } from "@/constants/Colors";

export type ThemedViewProps = ViewProps & {
  lightColor?: string;
  darkColor?: string;
};

export function ThemedView({
  style,
  lightColor,
  darkColor,
  ...otherProps
}: ThemedViewProps) {
  return (
    <View style={[{ backgroundColor: Colors.black }, style]} {...otherProps} />
  );
}
