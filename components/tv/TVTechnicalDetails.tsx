import type { MediaStream } from "@jellyfin/sdk/lib/generated-client/models";
import React from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { Text } from "@/components/common/Text";
import { Colors } from "@/constants/Colors";
import { useScaledTVTypography } from "@/constants/TVTypography";
import { scaleSize } from "@/utils/scaleSize";

export interface TVTechnicalDetailsProps {
  mediaStreams: MediaStream[];
}

export const TVTechnicalDetails: React.FC<TVTechnicalDetailsProps> = React.memo(
  ({ mediaStreams }) => {
    const typography = useScaledTVTypography();
    const { t } = useTranslation();

    const videoStream = mediaStreams.find((s) => s.Type === "Video");
    const audioStream = mediaStreams.find((s) => s.Type === "Audio");

    if (!videoStream && !audioStream) {
      return null;
    }

    return (
      <View style={{ marginBottom: scaleSize(32) }}>
        <Text
          style={{
            fontSize: typography.heading,
            fontWeight: "600",
            color: Colors.foreground,
            marginBottom: scaleSize(20),
          }}
        >
          {t("item_card.technical_details")}
        </Text>
        <View style={{ flexDirection: "row", gap: scaleSize(40) }}>
          {videoStream && (
            <View>
              <Text
                style={{
                  fontSize: typography.callout,
                  color: Colors.foregroundDisabled,
                  textTransform: "uppercase",
                  letterSpacing: 1,
                  marginBottom: scaleSize(4),
                }}
              >
                {t("common.video")}
              </Text>
              <Text
                style={{ fontSize: typography.body, color: Colors.foreground }}
              >
                {videoStream.DisplayTitle ||
                  `${videoStream.Codec?.toUpperCase()} ${videoStream.Width}x${videoStream.Height}`}
              </Text>
            </View>
          )}
          {audioStream && (
            <View>
              <Text
                style={{
                  fontSize: typography.callout,
                  color: Colors.foregroundDisabled,
                  textTransform: "uppercase",
                  letterSpacing: 1,
                  marginBottom: scaleSize(4),
                }}
              >
                {t("common.audio")}
              </Text>
              <Text
                style={{ fontSize: typography.body, color: Colors.foreground }}
              >
                {audioStream.DisplayTitle ||
                  `${audioStream.Codec?.toUpperCase()} ${audioStream.Channels}ch`}
              </Text>
            </View>
          )}
        </View>
      </View>
    );
  },
);
