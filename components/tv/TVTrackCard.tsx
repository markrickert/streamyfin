import { Ionicons } from "@expo/vector-icons";
import React from "react";
import {
  Animated,
  Pressable,
  StyleSheet,
  View,
  type ViewInstance,
} from "react-native";
import { Text } from "@/components/common/Text";
import { Colors } from "@/constants/Colors";
import { useScaledTVTypography } from "@/constants/TVTypography";
import { scaleSize } from "@/utils/scaleSize";
import { useTVFocusAnimation } from "./hooks/useTVFocusAnimation";

export interface TVTrackCardProps {
  label: string;
  sublabel?: string;
  selected: boolean;
  hasTVPreferredFocus?: boolean;
  onPress: () => void;
}

export const TVTrackCard = React.forwardRef<ViewInstance, TVTrackCardProps>(
  ({ label, sublabel, selected, hasTVPreferredFocus, onPress }, ref) => {
    const typography = useScaledTVTypography();
    const styles = createStyles(typography);
    const { focused, handleFocus, handleBlur, animatedStyle } =
      useTVFocusAnimation({ scaleAmount: 1.05 });

    return (
      <Pressable
        ref={ref}
        onPress={onPress}
        onFocus={handleFocus}
        onBlur={handleBlur}
        hasTVPreferredFocus={hasTVPreferredFocus}
      >
        <Animated.View
          style={[
            styles.trackCard,
            animatedStyle,
            {
              backgroundColor: focused
                ? Colors.white
                : selected
                  ? Colors.white20
                  : Colors.white10,
            },
          ]}
        >
          <Text
            style={[
              styles.trackCardText,
              { color: focused ? Colors.black : Colors.foreground },
              (focused || selected) && { fontWeight: "600" },
            ]}
            numberOfLines={2}
          >
            {label}
          </Text>
          {sublabel && (
            <Text
              style={[
                styles.trackCardSublabel,
                {
                  color: focused ? Colors.black60 : Colors.foregroundMuted,
                },
              ]}
              numberOfLines={1}
            >
              {sublabel}
            </Text>
          )}
          {selected && !focused && (
            <View style={styles.checkmark}>
              <Ionicons
                name='checkmark'
                size={scaleSize(16)}
                color={Colors.foreground}
              />
            </View>
          )}
        </Animated.View>
      </Pressable>
    );
  },
);

const createStyles = (typography: ReturnType<typeof useScaledTVTypography>) =>
  StyleSheet.create({
    trackCard: {
      width: scaleSize(180),
      height: scaleSize(80),
      borderRadius: scaleSize(14),
      justifyContent: "center",
      alignItems: "center",
      paddingHorizontal: scaleSize(12),
    },
    trackCardText: {
      fontSize: typography.callout,
      textAlign: "center",
    },
    trackCardSublabel: {
      fontSize: typography.callout,
      marginTop: scaleSize(2),
    },
    checkmark: {
      position: "absolute",
      top: scaleSize(8),
      right: scaleSize(8),
    },
  });
