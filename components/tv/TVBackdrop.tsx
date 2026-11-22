import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client/models";
import { LinearGradient } from "expo-linear-gradient";
import React from "react";
import { View } from "react-native";
import { ItemImage } from "@/components/common/ItemImage";
import { Colors } from "@/constants/Colors";

export interface TVBackdropProps {
  item: BaseItemDto;
}

export const TVBackdrop: React.FC<TVBackdropProps> = React.memo(({ item }) => {
  return (
    <View
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
      }}
    >
      <ItemImage
        variant='Backdrop'
        item={item}
        style={{
          width: "100%",
          height: "100%",
        }}
      />
      {/* Gradient overlays for readability */}
      <LinearGradient
        colors={[Colors.transparent, Colors.black60, Colors.black80]}
        locations={[0, 0.5, 1]}
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          height: "70%",
        }}
      />
      <LinearGradient
        colors={[Colors.black80, Colors.transparent]}
        start={{ x: 0, y: 0 }}
        end={{ x: 0.6, y: 0 }}
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          bottom: 0,
          width: "60%",
        }}
      />
    </View>
  );
});
