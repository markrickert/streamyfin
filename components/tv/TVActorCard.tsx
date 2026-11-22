import { Ionicons } from "@expo/vector-icons";
import React from "react";
import { Animated, Pressable, View, type ViewInstance } from "react-native";
import { Image } from "@/components/common/ServerImage";
import { Text } from "@/components/common/Text";
import { Colors } from "@/constants/Colors";
import { useScaledTVTypography } from "@/constants/TVTypography";
import { scaleSize } from "@/utils/scaleSize";
import { useTVFocusAnimation } from "./hooks/useTVFocusAnimation";

export interface TVActorCardProps {
  person: {
    Id?: string | null;
    Name?: string | null;
    Role?: string | null;
  };
  apiBasePath?: string;
  onPress: () => void;
  hasTVPreferredFocus?: boolean;
}

export const TVActorCard = React.forwardRef<ViewInstance, TVActorCardProps>(
  ({ person, apiBasePath, onPress, hasTVPreferredFocus }, ref) => {
    const typography = useScaledTVTypography();
    const { focused, handleFocus, handleBlur, animatedStyle } =
      useTVFocusAnimation();

    const imageUrl = person.Id
      ? `${apiBasePath}/Items/${person.Id}/Images/Primary?fillWidth=280&fillHeight=280&quality=90`
      : null;

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
              overflow: "hidden",
              backgroundColor: Colors.white10,
              marginBottom: scaleSize(14),
              borderWidth: scaleSize(2),
              borderColor: focused ? Colors.white : Colors.transparent,
            }}
          >
            {imageUrl ? (
              <Image
                source={{ uri: imageUrl }}
                style={{ width: "100%", height: "100%" }}
                contentFit='cover'
              />
            ) : (
              <View
                style={{
                  flex: 1,
                  justifyContent: "center",
                  alignItems: "center",
                }}
              >
                <Ionicons
                  name='person'
                  size={scaleSize(56)}
                  color={Colors.foregroundDisabled}
                />
              </View>
            )}
          </View>

          <Text
            style={{
              fontSize: typography.callout,
              fontWeight: "500",
              color: focused ? Colors.foreground : Colors.foreground,
              textAlign: "center",
              marginBottom: scaleSize(4),
            }}
            numberOfLines={2}
          >
            {person.Name}
          </Text>

          {person.Role && (
            <Text
              style={{
                fontSize: typography.callout,
                color: focused ? Colors.foreground : Colors.white50,
                textAlign: "center",
                fontWeight: "500",
              }}
              numberOfLines={2}
            >
              {person.Role}
            </Text>
          )}
        </Animated.View>
      </Pressable>
    );
  },
);
