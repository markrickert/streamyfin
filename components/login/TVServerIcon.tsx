import { LinearGradient } from "expo-linear-gradient";
import React, { useMemo } from "react";
import { Animated, Pressable, View, type ViewInstance } from "react-native";
import { Text } from "@/components/common/Text";
import { useTVFocusAnimation } from "@/components/tv/hooks/useTVFocusAnimation";
import { Colors, SERVER_GRADIENT_COLORS } from "@/constants/Colors";
import { useScaledTVTypography } from "@/constants/TVTypography";
import { scaleSize } from "@/utils/scaleSize";

// Generate a consistent gradient index based on URL (deterministic hash)
// Uses cyrb53 hash - fast and good distribution
const getGradientForString = (str: string): [string, string] => {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const hash = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  const index = Math.abs(hash) % SERVER_GRADIENT_COLORS.length;
  return SERVER_GRADIENT_COLORS[index];
};

export interface TVServerIconProps {
  name: string;
  address: string;
  onPress: () => void;
  onLongPress?: () => void;
  hasTVPreferredFocus?: boolean;
  disabled?: boolean;
}

export const TVServerIcon = React.forwardRef<ViewInstance, TVServerIconProps>(
  (
    {
      name,
      address,
      onPress,
      onLongPress,
      hasTVPreferredFocus,
      disabled = false,
    },
    ref,
  ) => {
    const typography = useScaledTVTypography();
    const { focused, handleFocus, handleBlur, animatedStyle } =
      useTVFocusAnimation();

    // Get the first letter of the server name (or address if no name)
    const displayName = name || address;
    const initial = displayName.charAt(0).toUpperCase();

    // Get a consistent gradient based on the server URL (deterministic)
    // Use address as primary key, fallback to name + displayName for uniqueness
    const hashKey = address || name || displayName;
    const [gradientStart, gradientEnd] = useMemo(
      () => getGradientForString(hashKey),
      [hashKey],
    );

    return (
      <Pressable
        ref={ref}
        onPress={onPress}
        onLongPress={onLongPress}
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
              shadowColor: gradientStart,
              shadowOffset: { width: 0, height: 0 },
              shadowOpacity: focused ? 0.7 : 0,
              shadowRadius: focused ? scaleSize(24) : 0,
            },
          ]}
        >
          <View
            style={{
              width: scaleSize(140),
              height: scaleSize(140),
              borderRadius: scaleSize(70),
              overflow: "hidden",
              marginBottom: scaleSize(14),
              borderWidth: focused ? scaleSize(3) : 0,
              borderColor: Colors.white,
            }}
          >
            <LinearGradient
              colors={[gradientStart, gradientEnd]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={{
                width: "100%",
                height: "100%",
                justifyContent: "center",
                alignItems: "center",
                opacity: focused ? 1 : 0.85,
              }}
            >
              <Text
                style={{
                  // biome-ignore lint/plugin: glyph, not text
                  fontSize: scaleSize(48),
                  fontWeight: "bold",
                  color: Colors.foreground,
                  textShadowColor: Colors.black30,
                  textShadowOffset: { width: 0, height: 2 },
                  textShadowRadius: 4,
                }}
              >
                {initial}
              </Text>
            </LinearGradient>
          </View>

          <Text
            style={{
              fontSize: typography.body,
              fontWeight: "600",
              color: focused ? Colors.foreground : Colors.foreground,
              textAlign: "center",
              marginBottom: scaleSize(4),
            }}
            numberOfLines={3}
          >
            {displayName}
          </Text>

          {name && (
            <Text
              style={{
                fontSize: typography.callout,
                color: focused ? Colors.foreground : Colors.white50,
                textAlign: "center",
              }}
              numberOfLines={3}
            >
              {address.replace(/^https?:\/\//, "")}
            </Text>
          )}
        </Animated.View>
      </Pressable>
    );
  },
);
