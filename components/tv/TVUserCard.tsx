import { Ionicons } from "@expo/vector-icons";
import React from "react";
import { useTranslation } from "react-i18next";
import { Animated, Pressable, View, type ViewInstance } from "react-native";
import { Text } from "@/components/common/Text";
import { Colors } from "@/constants/Colors";
import { useScaledTVTypography } from "@/constants/TVTypography";
import { scaleSize } from "@/utils/scaleSize";
import type { AccountSecurityType } from "@/utils/secureCredentials";
import { useTVFocusAnimation } from "./hooks/useTVFocusAnimation";

export interface TVUserCardProps {
  username: string;
  securityType: AccountSecurityType;
  hasTVPreferredFocus?: boolean;
  isCurrent?: boolean;
  onPress: () => void;
}

export const TVUserCard = React.forwardRef<ViewInstance, TVUserCardProps>(
  (
    {
      username,
      securityType,
      hasTVPreferredFocus = false,
      isCurrent = false,
      onPress,
    },
    ref,
  ) => {
    const { t } = useTranslation();
    const typography = useScaledTVTypography();
    const { focused, handleFocus, handleBlur, animatedStyle } =
      useTVFocusAnimation({ scaleAmount: isCurrent ? 1.02 : 1.05 });

    const getSecurityIcon = (): keyof typeof Ionicons.glyphMap => {
      switch (securityType) {
        case "pin":
          return "keypad";
        case "password":
          return "lock-closed";
        default:
          return "key";
      }
    };

    const getSecurityText = (): string => {
      switch (securityType) {
        case "pin":
          return t("save_account.pin_code");
        case "password":
          return t("save_account.password");
        default:
          return t("save_account.no_protection");
      }
    };

    const getBackgroundColor = () => {
      if (isCurrent) {
        return focused ? Colors.white10 : Colors.white05;
      }
      return focused ? Colors.white : Colors.white10;
    };

    const getTextColor = () => {
      if (isCurrent) {
        return Colors.white30;
      }
      return focused ? Colors.black : Colors.white;
    };

    const getSecondaryColor = () => {
      if (isCurrent) {
        return Colors.white20;
      }
      return focused ? Colors.black50 : Colors.white50;
    };

    return (
      <Pressable
        ref={ref}
        onPress={isCurrent ? undefined : onPress}
        onFocus={handleFocus}
        onBlur={handleBlur}
        hasTVPreferredFocus={hasTVPreferredFocus}
      >
        <Animated.View
          style={[
            animatedStyle,
            {
              flexDirection: "row",
              alignItems: "center",
              backgroundColor: getBackgroundColor(),
              borderRadius: scaleSize(14),
              paddingHorizontal: scaleSize(16),
              paddingVertical: scaleSize(14),
              gap: scaleSize(14),
            },
          ]}
        >
          {/* User Avatar */}
          <View
            style={{
              width: scaleSize(44),
              height: scaleSize(44),
              backgroundColor: isCurrent
                ? Colors.white10
                : focused
                  ? Colors.black10
                  : Colors.white10,
              borderRadius: scaleSize(22),
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Ionicons
              name='person'
              size={scaleSize(24)}
              color={getTextColor()}
            />
          </View>

          {/* Text column */}
          <View style={{ gap: scaleSize(4) }}>
            {/* Username */}
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: scaleSize(8),
              }}
            >
              <Text
                style={{
                  fontSize: typography.callout,
                  color: getTextColor(),
                  fontWeight: "600",
                }}
                numberOfLines={1}
              >
                {username}
              </Text>
              {isCurrent && (
                <Text
                  style={{
                    fontSize: typography.callout - 4,
                    color: Colors.foregroundDisabled,
                    fontStyle: "italic",
                  }}
                >
                  ({t("home.settings.switch_user.current")})
                </Text>
              )}
            </View>

            {/* Security indicator */}
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: scaleSize(4),
              }}
            >
              <Ionicons
                name={getSecurityIcon()}
                size={scaleSize(12)}
                color={getSecondaryColor()}
              />
              <Text
                style={{
                  fontSize: typography.callout - 4,
                  color: getSecondaryColor(),
                }}
                numberOfLines={1}
              >
                {getSecurityText()}
              </Text>
            </View>
          </View>
        </Animated.View>
      </Pressable>
    );
  },
);
