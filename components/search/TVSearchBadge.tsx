import React from "react";
import { Animated, Pressable } from "react-native";
import { Text } from "@/components/common/Text";
import { useTVFocusAnimation } from "@/components/tv/hooks/useTVFocusAnimation";
import { Colors } from "@/constants/Colors";
import { useScaledTVTypography } from "@/constants/TVTypography";

export interface TVSearchBadgeProps {
  label: string;
  onPress: () => void;
  hasTVPreferredFocus?: boolean;
}

export const TVSearchBadge: React.FC<TVSearchBadgeProps> = ({
  label,
  onPress,
  hasTVPreferredFocus = false,
}) => {
  const typography = useScaledTVTypography();
  const { focused, handleFocus, handleBlur, animatedStyle } =
    useTVFocusAnimation({ duration: 150 });

  return (
    <Pressable
      onPress={onPress}
      onFocus={handleFocus}
      onBlur={handleBlur}
      hasTVPreferredFocus={hasTVPreferredFocus}
    >
      <Animated.View
        style={[
          animatedStyle,
          {
            paddingHorizontal: 24,
            paddingVertical: 14,
            borderRadius: 24,
            backgroundColor: focused ? Colors.white : Colors.white10,
            shadowColor: Colors.white,
            shadowOffset: { width: 0, height: 0 },
            shadowOpacity: focused ? 0.4 : 0,
            shadowRadius: focused ? 12 : 0,
          },
        ]}
      >
        <Text
          style={{
            fontSize: typography.callout,
            color: focused ? Colors.black : Colors.foreground,
            fontWeight: focused ? "600" : "400",
          }}
        >
          {label}
        </Text>
      </Animated.View>
    </Pressable>
  );
};
