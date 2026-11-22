import React from "react";
import { Animated, Pressable } from "react-native";
import { Text } from "@/components/common/Text";
import { Colors } from "@/constants/Colors";
import { useScaledTVTypography } from "@/constants/TVTypography";
import { scaleSize } from "@/utils/scaleSize";
import { tvFocusedTextColor } from "@/utils/tvFocusColors";
import { useTVFocusAnimation } from "./hooks/useTVFocusAnimation";

export interface TVTabButtonProps {
  label: string;
  active: boolean;
  onSelect: () => void;
  hasTVPreferredFocus?: boolean;
  switchOnFocus?: boolean;
  disabled?: boolean;
}

export const TVTabButton: React.FC<TVTabButtonProps> = ({
  label,
  active,
  onSelect,
  hasTVPreferredFocus = false,
  switchOnFocus = false,
  disabled = false,
}) => {
  const typography = useScaledTVTypography();
  const { focused, handleFocus, handleBlur, animatedStyle } =
    useTVFocusAnimation({
      scaleAmount: 1.05,
      duration: 120,
      onFocus: switchOnFocus ? onSelect : undefined,
    });

  return (
    <Pressable
      onPress={onSelect}
      onFocus={handleFocus}
      onBlur={handleBlur}
      hasTVPreferredFocus={hasTVPreferredFocus && !disabled}
      disabled={disabled}
      focusable={!disabled}
    >
      <Animated.View
        style={[
          animatedStyle,
          {
            backgroundColor: focused
              ? Colors.white
              : active
                ? Colors.white20
                : "transparent",
            borderBottomColor: active ? Colors.white : Colors.transparent,
            borderBottomWidth: scaleSize(2),
            paddingHorizontal: scaleSize(20),
            paddingVertical: scaleSize(12),
            borderRadius: scaleSize(8),
          },
        ]}
      >
        <Text
          style={{
            fontSize: typography.callout,
            color: tvFocusedTextColor(focused),
            fontWeight: focused || active ? "600" : "400",
          }}
        >
          {label}
        </Text>
      </Animated.View>
    </Pressable>
  );
};
