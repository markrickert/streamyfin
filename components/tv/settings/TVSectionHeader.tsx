import React from "react";
import { Text } from "@/components/common/Text";
import { Colors } from "@/constants/Colors";
import { useScaledTVTypography } from "@/constants/TVTypography";

export interface TVSectionHeaderProps {
  title: string;
}

export const TVSectionHeader: React.FC<TVSectionHeaderProps> = ({ title }) => {
  const typography = useScaledTVTypography();

  return (
    <Text
      style={{
        fontSize: typography.callout,
        fontWeight: "600",
        color: Colors.foregroundMuted,
        textTransform: "uppercase",
        letterSpacing: 1,
        marginTop: 32,
        marginBottom: 16,
        marginLeft: 8,
      }}
    >
      {title}
    </Text>
  );
};
