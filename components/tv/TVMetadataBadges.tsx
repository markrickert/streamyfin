import { Ionicons } from "@expo/vector-icons";
import React from "react";
import { View } from "react-native";
import { Badge } from "@/components/Badge";
import { Text } from "@/components/common/Text";
import { Colors } from "@/constants/Colors";
import { useScaledTVTypography } from "@/constants/TVTypography";
import { scaleSize } from "@/utils/scaleSize";

export interface TVMetadataBadgesProps {
  year?: number | null;
  duration?: string | null;
  officialRating?: string | null;
  communityRating?: number | null;
  /** Extra badges to sit at the end of the row. */
  trailing?: React.ReactNode;
}

export const TVMetadataBadges: React.FC<TVMetadataBadgesProps> = React.memo(
  ({ year, duration, officialRating, communityRating, trailing }) => {
    const typography = useScaledTVTypography();

    return (
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          flexWrap: "wrap",
          gap: scaleSize(16),
          marginBottom: scaleSize(24),
        }}
      >
        {year != null && (
          <Text style={{ color: Colors.foreground, fontSize: typography.body }}>
            {year}
          </Text>
        )}
        {duration && (
          <Text style={{ color: Colors.foreground, fontSize: typography.body }}>
            {duration}
          </Text>
        )}
        {officialRating && <Badge text={officialRating} variant='gray' />}
        {communityRating != null && (
          <Badge
            text={communityRating.toFixed(1)}
            variant='gray'
            iconLeft={
              <Ionicons name='star' size={16} color={Colors.warningLight} />
            }
          />
        )}
        {trailing}
      </View>
    );
  },
);
