import { BlurView } from "expo-blur";
import { Platform, StyleSheet, View, type ViewProps } from "react-native";
import { Colors } from "@/constants/Colors";
import { useScaledTVTypography } from "@/constants/TVTypography";
import { GlassSurface } from "./common/GlassSurface";
import { Text } from "./common/Text";

interface Props extends ViewProps {
  text?: string | number | null;
  variant?: "gray" | "purple";
  iconLeft?: React.ReactNode;
}

export const Badge: React.FC<Props> = ({
  iconLeft,
  text,
  variant = "purple",
  ...props
}) => {
  const typography = useScaledTVTypography();

  const content = (
    <View style={styles.content}>
      {iconLeft && <View style={styles.iconLeft}>{iconLeft}</View>}
      <Text
        className={`
          text-xs
          ${variant === "purple" && "text-foreground"}
      `}
      >
        {text}
      </Text>
    </View>
  );

  if (Platform.OS === "ios" && !Platform.isTV) {
    return (
      <View {...props} style={[styles.container, props.style]}>
        <GlassSurface style={{ borderRadius: 100 }}>{content}</GlassSurface>
      </View>
    );
  }

  // On TV, use BlurView for consistent styling
  if (Platform.isTV) {
    return (
      <BlurView
        intensity={10}
        tint='light'
        style={{
          borderRadius: 8,
          overflow: "hidden",
          alignSelf: "flex-start",
          flexShrink: 1,
          flexGrow: 0,
        }}
      >
        <View
          style={[
            {
              paddingVertical: 10,
              paddingHorizontal: 16,
              flexDirection: "row",
              alignItems: "center",
              backgroundColor: Colors.black30,
            },
            props.style,
          ]}
        >
          {iconLeft && <View style={{ marginRight: 8 }}>{iconLeft}</View>}
          <Text
            style={{
              fontSize: typography.callout,
              color: Colors.foreground,
            }}
          >
            {text}
          </Text>
        </View>
      </BlurView>
    );
  }

  return (
    <View
      {...props}
      style={[
        {
          borderRadius: 4,
          padding: 4,
          paddingHorizontal: 6,
          flexShrink: 1,
          flexGrow: 0,
          alignSelf: "flex-start",
          flexDirection: "row",
          alignItems: "center",
          backgroundColor:
            variant === "purple" ? Colors.primary : Colors.surfaceRaised,
        },
        props.style,
      ]}
    >
      {iconLeft && <View style={{ marginRight: 4 }}>{iconLeft}</View>}
      <Text
        style={{
          fontSize: 12,
          color: Colors.foreground,
        }}
      >
        {text}
      </Text>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    overflow: "hidden",
    alignSelf: "flex-start",
    flexShrink: 1,
    flexGrow: 0,
  },
  content: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 50,
    backgroundColor: Colors.transparent,
  },
  iconLeft: {
    marginRight: 4,
  },
});
