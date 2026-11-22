import React from "react";
import { Animated, Pressable, View } from "react-native";
import { Text } from "@/components/common/Text";
import { Colors } from "@/constants/Colors";
import { useScaledTVTypography } from "@/constants/TVTypography";
import { scaleSize } from "@/utils/scaleSize";
import { useTVFocusAnimation } from "./hooks/useTVFocusAnimation";

export interface TVFilterButtonProps {
  label: string;
  value: string;
  onPress: () => void;
  hasTVPreferredFocus?: boolean;
  disabled?: boolean;
  hasActiveFilter?: boolean;
}

export const TVFilterButton: React.FC<TVFilterButtonProps> = ({
  label,
  value,
  onPress,
  hasTVPreferredFocus = false,
  disabled = false,
  hasActiveFilter = false,
}) => {
  const typography = useScaledTVTypography();
  const { focused, handleFocus, handleBlur, animatedStyle } =
    useTVFocusAnimation({ scaleAmount: 1.04, duration: 120 });

  return (
    <Pressable
      onPress={onPress}
      onFocus={handleFocus}
      onBlur={handleBlur}
      hasTVPreferredFocus={hasTVPreferredFocus && !disabled}
      disabled={disabled}
      focusable={!disabled}
    >
      <Animated.View style={animatedStyle}>
        <View
          style={{
            backgroundColor: focused
              ? Colors.white
              : hasActiveFilter
                ? Colors.white20
                : Colors.white10,
            borderRadius: scaleSize(10),
            paddingVertical: scaleSize(10),
            paddingHorizontal: scaleSize(16),
            flexDirection: "row",
            alignItems: "center",
            gap: scaleSize(8),
            borderWidth: hasActiveFilter && !focused ? scaleSize(1) : 0,
            borderColor: Colors.white30,
          }}
        >
          {label ? (
            <Text
              style={{
                fontSize: typography.callout,
                color: focused ? Colors.black : Colors.foregroundMuted,
              }}
            >
              {label}
            </Text>
          ) : null}
          <Text
            style={{
              fontSize: typography.callout,
              color: focused ? Colors.black : Colors.foreground,
              fontWeight: "500",
            }}
            numberOfLines={1}
          >
            {value}
          </Text>
        </View>
      </Animated.View>
    </Pressable>
  );
};
