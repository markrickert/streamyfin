import { Platform, Text as RNText, type TextProps } from "react-native";
import { Colors } from "@/constants/Colors";
export function Text(props: TextProps) {
  const { style, ...otherProps } = props;
  if (Platform.isTV)
    return (
      <RNText
        allowFontScaling={false}
        style={[{ color: Colors.foreground }, style]}
        {...otherProps}
      />
    );

  return (
    <RNText
      allowFontScaling={false}
      style={[{ color: Colors.foreground }, style]}
      {...otherProps}
    />
  );
}
