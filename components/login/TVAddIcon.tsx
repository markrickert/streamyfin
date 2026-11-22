import { Ionicons } from "@expo/vector-icons";
import React from "react";
import { Animated, Pressable, View, type ViewInstance } from "react-native";
import { Text } from "@/components/common/Text";
import { useTVFocusAnimation } from "@/components/tv/hooks/useTVFocusAnimation";
import { Colors } from "@/constants/Colors";
import { useScaledTVTypography } from "@/constants/TVTypography";
import { scaleSize } from "@/utils/scaleSize";

export interface TVAddIconProps {
  label: string;
  onPress: () => void;
  hasTVPreferredFocus?: boolean;
  disabled?: boolean;
}

export const TVAddIcon = React.forwardRef<ViewInstance, TVAddIconProps>(
  ({ label, onPress, hasTVPreferredFocus, disabled = false }, ref) => {
    const typography = useScaledTVTypography();
    const { focused, handleFocus, handleBlur, animatedStyle } =
      useTVFocusAnimation();

    return (
      <Pressable
        ref={ref}
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
              alignItems: "center",
              width: scaleSize(160),
              shadowColor: Colors.white,
              shadowOffset: { width: 0, height: 0 },
              shadowOpacity: focused ? 0.5 : 0,
              shadowRadius: focused ? scaleSize(16) : 0,
            },
          ]}
        >
          <View
            style={{
              width: scaleSize(140),
              height: scaleSize(140),
              borderRadius: scaleSize(70),
              backgroundColor: focused ? Colors.white10 : Colors.white05,
              marginBottom: scaleSize(14),
              borderWidth: scaleSize(2),
              borderColor: focused ? Colors.white : Colors.white30,
              borderStyle: "dashed",
              justifyContent: "center",
              alignItems: "center",
            }}
          >
            <Ionicons
              name='add'
              size={scaleSize(56)}
              color={focused ? Colors.foreground : Colors.foregroundMuted}
            />
          </View>

          <Text
            style={{
              fontSize: typography.body,
              fontWeight: "600",
              color: focused ? Colors.foreground : Colors.foregroundMuted,
              textAlign: "center",
            }}
            numberOfLines={2}
          >
            {label}
          </Text>
        </Animated.View>
      </Pressable>
    );
  },
);
