import { Ionicons } from "@expo/vector-icons";
import React, { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Animated, Easing, Pressable, View } from "react-native";
import { Text } from "@/components/common/Text";
import { Colors } from "@/constants/Colors";
import { useScaledTVTypography } from "@/constants/TVTypography";
import { scaleSize } from "@/utils/scaleSize";
import type { SavedServerAccount } from "@/utils/secureCredentials";

interface TVAccountCardProps {
  account: SavedServerAccount;
  onPress: () => void;
  onLongPress?: () => void;
  hasTVPreferredFocus?: boolean;
}

export const TVAccountCard: React.FC<TVAccountCardProps> = ({
  account,
  onPress,
  onLongPress,
  hasTVPreferredFocus,
}) => {
  const typography = useScaledTVTypography();
  const { t } = useTranslation();
  const [isFocused, setIsFocused] = useState(false);
  const scale = useRef(new Animated.Value(1)).current;
  const glowOpacity = useRef(new Animated.Value(0)).current;

  const animateFocus = (focused: boolean) => {
    Animated.parallel([
      Animated.timing(scale, {
        toValue: focused ? 1.03 : 1,
        duration: 150,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
      Animated.timing(glowOpacity, {
        toValue: focused ? 0.6 : 0,
        duration: 150,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
    ]).start();
  };

  const handleFocus = () => {
    setIsFocused(true);
    animateFocus(true);
  };

  const handleBlur = () => {
    setIsFocused(false);
    animateFocus(false);
  };

  const getSecurityIcon = (): keyof typeof Ionicons.glyphMap => {
    switch (account.securityType) {
      case "pin":
        return "keypad";
      case "password":
        return "lock-closed";
      default:
        return "key";
    }
  };

  const getSecurityText = (): string => {
    switch (account.securityType) {
      case "pin":
        return t("save_account.pin_code");
      case "password":
        return t("save_account.password");
      default:
        return t("save_account.no_protection");
    }
  };

  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      onFocus={handleFocus}
      onBlur={handleBlur}
      hasTVPreferredFocus={hasTVPreferredFocus}
    >
      <Animated.View
        style={[
          {
            transform: [{ scale }],
            shadowColor: Colors.white,
            shadowOffset: { width: 0, height: 0 },
            shadowRadius: 16,
            elevation: 8,
          },
          { shadowOpacity: glowOpacity },
        ]}
      >
        <View
          style={{
            backgroundColor: isFocused
              ? Colors.surfaceRaised
              : Colors.surfaceRaised,
            borderWidth: 2,
            borderColor: isFocused ? Colors.white : Colors.transparent,
            borderRadius: scaleSize(16),
            paddingHorizontal: scaleSize(24),
            paddingVertical: scaleSize(20),
            flexDirection: "row",
            alignItems: "center",
          }}
        >
          {/* Avatar */}
          <View
            style={{
              width: scaleSize(56),
              height: scaleSize(56),
              backgroundColor: Colors.border,
              borderRadius: scaleSize(28),
              alignItems: "center",
              justifyContent: "center",
              marginRight: scaleSize(20),
            }}
          >
            <Ionicons
              name='person'
              size={scaleSize(28)}
              color={Colors.foreground}
            />
          </View>

          {/* Account Info */}
          <View style={{ flex: 1 }}>
            <Text
              style={{
                fontSize: typography.heading,
                fontWeight: "600",
                color: Colors.foreground,
              }}
            >
              {account.username}
            </Text>
            <Text
              style={{
                fontSize: typography.callout,
                color: Colors.foregroundMuted,
                marginTop: scaleSize(4),
              }}
            >
              {getSecurityText()}
            </Text>
          </View>

          {/* Security Icon */}
          <Ionicons
            name={getSecurityIcon()}
            size={scaleSize(24)}
            color={Colors.foreground}
          />
        </View>
      </Animated.View>
    </Pressable>
  );
};
