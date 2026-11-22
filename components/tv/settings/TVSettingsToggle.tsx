import React from "react";
import { useTranslation } from "react-i18next";
import { Animated, Pressable, View } from "react-native";
import { Text } from "@/components/common/Text";
import { Colors } from "@/constants/Colors";
import { useScaledTVTypography } from "@/constants/TVTypography";
import { scaleSize } from "@/utils/scaleSize";
import { useTVFocusAnimation } from "../hooks/useTVFocusAnimation";

export interface TVSettingsToggleProps {
  label: string;
  value: boolean;
  onToggle: (value: boolean) => void;
  disabled?: boolean;
  /**
   * Locked by the Streamyfin plugin. Distinct from `disabled` because the row
   * has to say *why*: an admin-locked setting is dropped on write and overridden
   * on read, so without a visible reason it just looks like a broken toggle.
   */
  disabledByAdmin?: boolean;
}

export const TVSettingsToggle: React.FC<TVSettingsToggleProps> = ({
  label,
  value,
  onToggle,
  disabled,
  disabledByAdmin,
}) => {
  const { t } = useTranslation();
  const isDisabled = disabled || disabledByAdmin;
  const typography = useScaledTVTypography();
  const { focused, handleFocus, handleBlur, animatedStyle } =
    useTVFocusAnimation({ scaleAmount: 1.02 });

  return (
    <Pressable
      onPress={() => onToggle(!value)}
      onFocus={handleFocus}
      onBlur={handleBlur}
      disabled={isDisabled}
      focusable={!isDisabled}
    >
      <Animated.View
        style={[
          animatedStyle,
          {
            backgroundColor: focused ? Colors.white10 : Colors.white05,
            borderRadius: scaleSize(12),
            paddingVertical: scaleSize(16),
            paddingHorizontal: scaleSize(24),
            marginBottom: scaleSize(8),
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            opacity: isDisabled ? 0.4 : 1,
          },
        ]}
      >
        <View>
          <Text style={{ fontSize: typography.body, color: Colors.foreground }}>
            {label}
          </Text>
          {disabledByAdmin && (
            <Text
              style={{
                fontSize: typography.callout,
                color: Colors.danger,
                marginTop: scaleSize(2),
              }}
            >
              {t("home.settings.disabled_by_admin")}
            </Text>
          )}
        </View>
        <View
          style={{
            width: scaleSize(56),
            height: scaleSize(32),
            borderRadius: scaleSize(16),
            backgroundColor: value ? Colors.white : Colors.border,
            justifyContent: "center",
            paddingHorizontal: scaleSize(2),
          }}
        >
          <View
            style={{
              width: scaleSize(28),
              height: scaleSize(28),
              borderRadius: scaleSize(14),
              backgroundColor: value ? Colors.black : Colors.white,
              alignSelf: value ? "flex-end" : "flex-start",
            }}
          />
        </View>
      </Animated.View>
    </Pressable>
  );
};
