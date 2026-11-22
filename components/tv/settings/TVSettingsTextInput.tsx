import React, { useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  Animated,
  Pressable,
  TextInput,
  type TextInputInstance,
} from "react-native";
import { Text } from "@/components/common/Text";
import { Colors } from "@/constants/Colors";
import { useScaledTVTypography } from "@/constants/TVTypography";
import { scaleSize } from "@/utils/scaleSize";
import { useTVFocusAnimation } from "../hooks/useTVFocusAnimation";

export interface TVSettingsTextInputProps {
  label: string;
  value: string;
  placeholder?: string;
  onChangeText: (text: string) => void;
  onBlur?: () => void;
  secureTextEntry?: boolean;
  disabled?: boolean;
  /** Locked by the Streamyfin plugin; dims the row and says so. */
  disabledByAdmin?: boolean;
}

export const TVSettingsTextInput: React.FC<TVSettingsTextInputProps> = ({
  label,
  value,
  placeholder,
  onChangeText,
  onBlur,
  secureTextEntry,
  disabled,
  disabledByAdmin,
}) => {
  const { t } = useTranslation();
  const isDisabled = disabled || disabledByAdmin;
  const typography = useScaledTVTypography();
  const inputRef = useRef<TextInputInstance>(null);
  const { focused, handleFocus, handleBlur, animatedStyle } =
    useTVFocusAnimation({ scaleAmount: 1.02 });

  const handleInputBlur = () => {
    handleBlur();
    onBlur?.();
  };

  return (
    <Pressable
      onPress={() => inputRef.current?.focus()}
      onFocus={handleFocus}
      onBlur={handleInputBlur}
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
            opacity: isDisabled ? 0.4 : 1,
          },
        ]}
      >
        <Text
          style={{
            fontSize: typography.callout,
            color: Colors.foregroundMuted,
            marginBottom: scaleSize(8),
          }}
        >
          {label}
        </Text>
        {disabledByAdmin && (
          <Text
            style={{
              fontSize: typography.callout,
              color: Colors.danger,
              marginBottom: scaleSize(8),
            }}
          >
            {t("home.settings.disabled_by_admin")}
          </Text>
        )}
        <TextInput
          ref={inputRef}
          value={value}
          placeholder={placeholder}
          placeholderTextColor={Colors.foregroundDisabled}
          onChangeText={onChangeText}
          onBlur={handleInputBlur}
          secureTextEntry={secureTextEntry}
          autoCapitalize='none'
          autoCorrect={false}
          style={{
            fontSize: typography.body,
            color: Colors.foreground,
            backgroundColor: Colors.white05,
            borderRadius: scaleSize(8),
            paddingVertical: scaleSize(12),
            paddingHorizontal: scaleSize(16),
            borderWidth: focused ? scaleSize(2) : scaleSize(1),
            borderColor: focused ? Colors.white : Colors.border,
          }}
        />
      </Animated.View>
    </Pressable>
  );
};
