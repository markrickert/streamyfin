import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client";
import React from "react";
import { useTranslation } from "react-i18next";
import {
  Animated,
  Pressable,
  StyleSheet,
  View,
  type ViewInstance,
} from "react-native";
import { Text } from "@/components/common/Text";
import { useTVFocusAnimation } from "@/components/tv/hooks/useTVFocusAnimation";
import { Colors } from "@/constants/Colors";
import { useScaledTVTypography } from "@/constants/TVTypography";

interface TVGuideProgramCellProps {
  program: BaseItemDto;
  width: number;
  isCurrentlyAiring: boolean;
  onPress: () => void;
  disabled?: boolean;
  refSetter?: (ref: ViewInstance | null) => void;
}

export const TVGuideProgramCell: React.FC<TVGuideProgramCellProps> = ({
  program,
  width,
  isCurrentlyAiring,
  onPress,
  disabled = false,
  refSetter,
}) => {
  const { t } = useTranslation();
  const typography = useScaledTVTypography();
  const { focused, handleFocus, handleBlur } = useTVFocusAnimation({
    scaleAmount: 1,
    duration: 120,
  });

  const formatTime = (date: string | null | undefined) => {
    if (!date) return "";
    const d = new Date(date);
    return d.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  };

  return (
    <Pressable
      ref={refSetter}
      onPress={onPress}
      onFocus={handleFocus}
      onBlur={handleBlur}
      disabled={disabled}
      focusable={!disabled}
      style={{ width }}
    >
      <Animated.View
        style={[
          styles.container,
          {
            backgroundColor: focused
              ? Colors.white
              : isCurrentlyAiring
                ? Colors.white10
                : Colors.white10,
            borderColor: focused ? Colors.white : Colors.white10,
          },
          focused && styles.focusedShadow,
        ]}
      >
        {/* LIVE badge */}
        {isCurrentlyAiring && (
          <View style={styles.liveBadge}>
            <Text
              style={[styles.liveBadgeText, { fontSize: typography.callout }]}
            >
              {t("player.live")}
            </Text>
          </View>
        )}

        {/* Program name */}
        <Text
          numberOfLines={2}
          style={[
            styles.programName,
            {
              fontSize: typography.callout,
              color: focused ? Colors.black : Colors.foreground,
            },
          ]}
        >
          {program.Name}
        </Text>

        {/* Time range */}
        <Text
          numberOfLines={1}
          style={[
            styles.timeText,
            {
              fontSize: typography.callout,
              color: focused ? Colors.black60 : Colors.white50,
            },
          ]}
        >
          {formatTime(program.StartDate)} - {formatTime(program.EndDate)}
        </Text>
      </Animated.View>
    </Pressable>
  );
};

const styles = StyleSheet.create({
  container: {
    height: 70,
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
    justifyContent: "center",
    overflow: "hidden",
  },
  focusedShadow: {
    shadowColor: Colors.white,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.4,
    shadowRadius: 12,
  },
  liveBadge: {
    position: "absolute",
    top: 6,
    right: 6,
    backgroundColor: Colors.danger,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    zIndex: 10,
    elevation: 10,
  },
  liveBadgeText: {
    color: Colors.foreground,
    fontWeight: "bold",
  },
  programName: {
    fontWeight: "600",
    marginBottom: 4,
  },
  timeText: {
    fontWeight: "400",
  },
});
