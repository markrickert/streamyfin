import { Ionicons } from "@expo/vector-icons";
import React from "react";
import { Animated, Pressable, View } from "react-native";
import { Text } from "@/components/common/Text";
import { useTVFocusAnimation } from "@/components/tv/hooks/useTVFocusAnimation";
import { Colors } from "@/constants/Colors";
import { useScaledTVTypography } from "@/constants/TVTypography";

interface TVRequestOptionRowProps {
  label: string;
  value: string;
  onPress: () => void;
  hasTVPreferredFocus?: boolean;
  disabled?: boolean;
}

export const TVRequestOptionRow: React.FC<TVRequestOptionRowProps> = ({
  label,
  value,
  onPress,
  hasTVPreferredFocus = false,
  disabled = false,
}) => {
  const typography = useScaledTVTypography();
  const { focused, handleFocus, handleBlur, animatedStyle } =
    useTVFocusAnimation({
      scaleAmount: 1.02,
    });

  return (
    <Pressable
      onPress={onPress}
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
            flexDirection: "row",
            justifyContent: "space-between",
            alignItems: "center",
            paddingVertical: 14,
            paddingHorizontal: 16,
            backgroundColor: focused ? Colors.white10 : Colors.white05,
            borderRadius: 10,
            borderWidth: 1,
            borderColor: focused ? Colors.white30 : Colors.white10,
          },
        ]}
      >
        <Text
          style={{
            fontSize: typography.callout,
            color: Colors.foregroundMuted,
          }}
        >
          {label}
        </Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text
            style={{
              fontSize: typography.body,
              color: focused ? Colors.foreground : Colors.foreground,
              fontWeight: "500",
            }}
            numberOfLines={1}
          >
            {value}
          </Text>
          <Ionicons
            name='chevron-forward'
            size={18}
            color={focused ? Colors.foreground : Colors.foregroundMuted}
          />
        </View>
      </Animated.View>
    </Pressable>
  );
};
