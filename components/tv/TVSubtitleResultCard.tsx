import { Ionicons } from "@expo/vector-icons";
import React from "react";
import { useTranslation } from "react-i18next";
import {
  ActivityIndicator,
  Animated,
  Pressable,
  StyleSheet,
  View,
  type ViewInstance,
} from "react-native";
import { Text } from "@/components/common/Text";
import { Colors } from "@/constants/Colors";
import { useScaledTVTypography } from "@/constants/TVTypography";
import type { SubtitleSearchResult } from "@/hooks/useRemoteSubtitles";
import { scaleSize } from "@/utils/scaleSize";
import { useTVFocusAnimation } from "./hooks/useTVFocusAnimation";

export interface TVSubtitleResultCardProps {
  result: SubtitleSearchResult;
  hasTVPreferredFocus?: boolean;
  isDownloading?: boolean;
  onPress: () => void;
}

export const TVSubtitleResultCard = React.forwardRef<
  ViewInstance,
  TVSubtitleResultCardProps
>(({ result, hasTVPreferredFocus, isDownloading, onPress }, ref) => {
  const typography = useScaledTVTypography();
  const styles = createStyles(typography);
  const { focused, handleFocus, handleBlur, animatedStyle } =
    useTVFocusAnimation({ scaleAmount: 1.03 });
  const { t } = useTranslation();

  return (
    <Pressable
      ref={ref}
      onPress={onPress}
      onFocus={handleFocus}
      onBlur={handleBlur}
      hasTVPreferredFocus={hasTVPreferredFocus}
      disabled={isDownloading}
    >
      <Animated.View
        style={[
          styles.resultCard,
          animatedStyle,
          {
            backgroundColor: focused ? Colors.white : Colors.white10,
            borderColor: focused ? Colors.white80 : Colors.white10,
          },
        ]}
      >
        {/* Provider/Source badge */}
        <View
          style={[
            styles.providerBadge,
            {
              backgroundColor: focused ? Colors.black10 : Colors.white10,
            },
          ]}
        >
          <Text
            style={[
              styles.providerText,
              { color: focused ? Colors.black60 : Colors.foregroundMuted },
            ]}
          >
            {result.providerName}
          </Text>
        </View>

        {/* Name */}
        <Text
          style={[
            styles.resultName,
            { color: focused ? Colors.black : Colors.foreground },
          ]}
          numberOfLines={2}
        >
          {result.name}
        </Text>

        {/* Meta info row */}
        <View style={styles.resultMeta}>
          {/* Format */}
          <Text
            style={[
              styles.resultMetaText,
              { color: focused ? Colors.black60 : Colors.foregroundMuted },
            ]}
          >
            {result.format?.toUpperCase()}
          </Text>

          {/* Rating if available */}
          {result.communityRating !== undefined &&
            result.communityRating > 0 && (
              <View style={styles.ratingContainer}>
                <Ionicons
                  name='star'
                  size={12}
                  color={focused ? Colors.black60 : Colors.foregroundMuted}
                />
                <Text
                  style={[
                    styles.resultMetaText,
                    {
                      color: focused ? Colors.black60 : Colors.white50,
                    },
                  ]}
                >
                  {result.communityRating.toFixed(1)}
                </Text>
              </View>
            )}

          {/* Download count if available */}
          {result.downloadCount !== undefined && result.downloadCount > 0 && (
            <View style={styles.downloadCountContainer}>
              <Ionicons
                name='download-outline'
                size={12}
                color={focused ? Colors.black60 : Colors.foregroundMuted}
              />
              <Text
                style={[
                  styles.resultMetaText,
                  {
                    color: focused ? Colors.black60 : Colors.white50,
                  },
                ]}
              >
                {result.downloadCount.toLocaleString()}
              </Text>
            </View>
          )}
        </View>

        {/* Flags */}
        <View style={styles.flagsContainer}>
          {result.isHashMatch && (
            <View
              style={[
                styles.flag,
                {
                  backgroundColor: focused
                    ? Colors.successSubtle
                    : Colors.successSubtle,
                },
              ]}
            >
              <Text style={styles.flagText}>{t("player.hash_match")}</Text>
            </View>
          )}
          {result.hearingImpaired && (
            <View
              style={[
                styles.flag,
                {
                  backgroundColor: focused ? Colors.black10 : Colors.white10,
                },
              ]}
            >
              <Ionicons
                name='ear-outline'
                size={12}
                color={focused ? Colors.black : Colors.foreground}
              />
            </View>
          )}
          {result.aiTranslated && (
            <View
              style={[
                styles.flag,
                {
                  backgroundColor: focused
                    ? Colors.infoSubtle
                    : Colors.infoSubtle,
                },
              ]}
            >
              <Text style={styles.flagText}>AI</Text>
            </View>
          )}
        </View>

        {/* Loading indicator when downloading */}
        {isDownloading && (
          <View style={styles.downloadingOverlay}>
            <ActivityIndicator size='small' color={Colors.foreground} />
          </View>
        )}
      </Animated.View>
    </Pressable>
  );
});

const createStyles = (typography: ReturnType<typeof useScaledTVTypography>) =>
  StyleSheet.create({
    resultCard: {
      width: scaleSize(220),
      minHeight: scaleSize(120),
      borderRadius: scaleSize(14),
      padding: scaleSize(14),
      borderWidth: scaleSize(1),
    },
    providerBadge: {
      alignSelf: "flex-start",
      paddingHorizontal: scaleSize(8),
      paddingVertical: scaleSize(3),
      borderRadius: scaleSize(6),
      marginBottom: scaleSize(8),
    },
    providerText: {
      fontSize: typography.callout,
      fontWeight: "600",
      textTransform: "uppercase",
      letterSpacing: 0.5,
    },
    resultName: {
      fontSize: typography.callout,
      fontWeight: "500",
      marginBottom: scaleSize(8),
      lineHeight: scaleSize(18),
    },
    resultMeta: {
      flexDirection: "row",
      alignItems: "center",
      gap: scaleSize(12),
      marginBottom: scaleSize(8),
    },
    resultMetaText: {
      fontSize: typography.callout,
    },
    ratingContainer: {
      flexDirection: "row",
      alignItems: "center",
      gap: scaleSize(3),
    },
    downloadCountContainer: {
      flexDirection: "row",
      alignItems: "center",
      gap: scaleSize(3),
    },
    flagsContainer: {
      flexDirection: "row",
      gap: scaleSize(6),
      flexWrap: "wrap",
    },
    flag: {
      paddingHorizontal: scaleSize(6),
      paddingVertical: scaleSize(2),
      borderRadius: scaleSize(4),
    },
    flagText: {
      fontSize: typography.callout,
      fontWeight: "600",
      color: Colors.foreground,
    },
    downloadingOverlay: {
      ...StyleSheet.absoluteFill,
      backgroundColor: Colors.black50,
      borderRadius: scaleSize(14),
      justifyContent: "center",
      alignItems: "center",
    },
  });
