import { Ionicons } from "@expo/vector-icons";
import React from "react";
import { Animated, Pressable, View } from "react-native";
import { Text } from "@/components/common/Text";
import { Colors } from "@/constants/Colors";
import { useScaledTVTypography } from "@/constants/TVTypography";
import { scaleSize } from "@/utils/scaleSize";
import { useTVFocusAnimation } from "../hooks/useTVFocusAnimation";

export interface TVSettingsRowProps {
  label: string;
  value: string;
  onPress?: () => void;
  showChevron?: boolean;
  disabled?: boolean;
}

export const TVSettingsRow: React.FC<TVSettingsRowProps> = ({
  label,
  value,
  onPress,
  showChevron = true,
  disabled,
}) => {
  const typography = useScaledTVTypography();
  const { focused, handleFocus, handleBlur, animatedStyle } =
    useTVFocusAnimation({ scaleAmount: 1.02 });

  return (
    <Pressable
      onPress={onPress}
      onFocus={handleFocus}
      onBlur={handleBlur}
      disabled={disabled}
      focusable={!disabled}
    >
      <Animated.View
        style={[
          animatedStyle,
          {
            backgroundColor: focused ? Colors.white10 : Colors.white05,
            borderRadius: scaleSize(12),
            paddingVertical: scaleSize(16),
            paddingHorizontal: scaleSize(24),
            marginBottom: scaleSize(8),
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
          },
        ]}
      >
        <Text style={{ fontSize: typography.body, color: Colors.foreground }}>
          {label}
        </Text>
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          <Text
            style={{
              fontSize: typography.callout,
              color: Colors.foregroundMuted,
              marginRight: showChevron ? scaleSize(12) : 0,
            }}
          >
            {value}
          </Text>
          {showChevron && (
            <Ionicons
              name='chevron-forward'
              size={scaleSize(20)}
              color={Colors.foregroundDisabled}
            />
          )}
        </View>
      </Animated.View>
    </Pressable>
  );
};
