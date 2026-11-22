import { Ionicons } from "@expo/vector-icons";
import React, { useRef, useState } from "react";
import { Animated, Easing, Pressable, View } from "react-native";
import { AnimatedEqualizer } from "@/components/music/AnimatedEqualizer";
import { Colors } from "@/constants/Colors";
import { scaleSize } from "@/utils/scaleSize";

interface TVThemeMusicIndicatorProps {
  isPlaying: boolean;
  isMuted: boolean;
  hasThemeMusic: boolean;
  onToggleMute: () => void;
  disabled?: boolean;
}

export const TVThemeMusicIndicator: React.FC<TVThemeMusicIndicatorProps> = ({
  isPlaying,
  isMuted,
  hasThemeMusic,
  onToggleMute,
  disabled = false,
}) => {
  const [focused, setFocused] = useState(false);
  const scale = useRef(new Animated.Value(1)).current;

  const animateTo = (v: number) =>
    Animated.timing(scale, {
      toValue: v,
      duration: 150,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start();

  if (!hasThemeMusic || !isPlaying) return null;

  return (
    <Pressable
      onPress={onToggleMute}
      onFocus={() => {
        setFocused(true);
        animateTo(1.15);
      }}
      onBlur={() => {
        setFocused(false);
        animateTo(1);
      }}
      disabled={disabled}
      focusable={!disabled}
    >
      <Animated.View
        style={{
          transform: [{ scale }],
          backgroundColor: focused ? Colors.white20 : Colors.white10,
          borderRadius: scaleSize(12),
          padding: scaleSize(12),
          alignItems: "center",
          justifyContent: "center",
          width: scaleSize(48),
          height: scaleSize(48),
        }}
      >
        {isMuted ? (
          <Ionicons
            name='volume-mute'
            size={scaleSize(22)}
            color={Colors.foreground}
          />
        ) : (
          <View style={{ marginRight: 0 }}>
            <AnimatedEqualizer
              color={Colors.foreground}
              barWidth={scaleSize(3)}
              barCount={3}
              height={scaleSize(18)}
              gap={scaleSize(2)}
            />
          </View>
        )}
      </Animated.View>
    </Pressable>
  );
};
