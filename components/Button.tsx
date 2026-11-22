import type React from "react";
import {
  type PropsWithChildren,
  type ReactNode,
  useRef,
  useState,
} from "react";
import {
  Animated,
  Easing,
  Platform,
  Pressable,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { Colors } from "@/constants/Colors";
import { useHaptic } from "@/hooks/useHaptic";
import { scaleSize } from "@/utils/scaleSize";
import { Loader } from "./Loader";

const getColorClasses = (
  color: "purple" | "red" | "black" | "transparent" | "white",
  variant: "solid" | "border",
  focused: boolean,
): string => {
  if (variant === "border") {
    switch (color) {
      case "purple":
        return focused
          ? "bg-transparent border-2 border-accent"
          : "bg-transparent border-2 border-primary";
      case "red":
        return focused
          ? "bg-transparent border-2 border-danger-light"
          : "bg-transparent border-2 border-danger";
      case "black":
        return focused
          ? "bg-transparent border-2 border-border"
          : "bg-transparent border-2 border-surface";
      case "white":
        return focused
          ? "bg-transparent border-2 border-foreground"
          : "bg-transparent border-2 border-white";
      case "transparent":
        return focused
          ? "bg-transparent border-2 border-foreground-muted"
          : "bg-transparent border-2 border-border";
      default:
        return "";
    }
  } else {
    switch (color) {
      case "purple":
        return focused
          ? "bg-primary border-2 border-white"
          : "bg-primary border border-primary-dark";
      case "red":
        return "bg-danger";
      case "black":
        return "bg-surface";
      case "white":
        return focused
          ? "bg-white border-2 border-foreground-muted"
          : "bg-white border border-foreground";
      case "transparent":
        return "bg-transparent";
      default:
        return "";
    }
  }
};

export interface ButtonProps
  extends React.ComponentProps<typeof TouchableOpacity> {
  onPress?: () => void;
  className?: string;
  textClassName?: string;
  disabled?: boolean;
  children?: string | ReactNode;
  loading?: boolean;
  color?: "purple" | "red" | "black" | "transparent" | "white";
  variant?: "solid" | "border";
  iconRight?: ReactNode;
  iconLeft?: ReactNode;
  justify?: "center" | "between";
}

export const Button: React.FC<PropsWithChildren<ButtonProps>> = ({
  onPress,
  className = "",
  textClassName = "",
  disabled = false,
  loading = false,
  color = "purple",
  variant = "solid",
  iconRight,
  iconLeft,
  children,
  justify = "center",
  ...props
}) => {
  const [focused, setFocused] = useState(false);
  const scale = useRef(new Animated.Value(1)).current;

  const animateTo = (v: number) =>
    Animated.timing(scale, {
      toValue: v,
      duration: 130,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start();

  const colorClasses = getColorClasses(color, variant, focused);

  const lightHapticFeedback = useHaptic("light");

  const textColorClass =
    color === "white" && variant === "solid" ? "text-black" : "text-foreground";

  return Platform.isTV ? (
    <Pressable
      className='w-full'
      onPress={onPress}
      onFocus={() => {
        setFocused(true);
        animateTo(1.03);
      }}
      onBlur={() => {
        setFocused(false);
        animateTo(1);
      }}
    >
      <Animated.View
        style={{
          transform: [{ scale }],
          shadowColor: Colors.white,
          shadowOffset: { width: 0, height: 0 },
          shadowOpacity: focused ? 0.5 : 0,
          shadowRadius: focused ? scaleSize(10) : 0,
          elevation: focused ? 12 : 0, // Android glow
        }}
      >
        <View
          style={{
            borderRadius: scaleSize(16),
            paddingVertical: scaleSize(14),
            alignItems: "center",
            justifyContent: "center",
          }}
          className={`${colorClasses} ${className}`}
        >
          <Text
            style={{
              fontSize: scaleSize(20),
              fontWeight: "bold",
            }}
            className={textColorClass}
          >
            {children}
          </Text>
        </View>
      </Animated.View>
    </Pressable>
  ) : (
    <TouchableOpacity
      className={`
        p-3 rounded-xl items-center justify-center
        ${(loading || disabled) && "opacity-50"}
        ${colorClasses}
        ${className}
      `}
      onPress={() => {
        if (!loading && !disabled && onPress) {
          onPress();
          lightHapticFeedback();
        }
      }}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? (
        <View className='p-0.5'>
          <Loader />
        </View>
      ) : (
        // Styles rather than classes: the row carried both justify classes, and
        // which one won differed between builds. Centered, the icon and its
        // label are one block: the placeholders only keep a "between" label
        // clear of the edges, and centered they pushed it off its middle.
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: justify === "between" ? "space-between" : "center",
            width: "100%",
          }}
        >
          {iconLeft ?? (justify === "between" && <View className='w-4' />)}
          <Text
            className={`
          ${textColorClass} font-bold text-base
          ${disabled ? "text-foreground" : ""}
          ${textClassName}
          ${iconRight ? "mr-2" : ""}
          ${iconLeft ? "ml-2" : ""}
        `}
          >
            {children}
          </Text>
          {iconRight ?? (justify === "between" && <View className='w-4' />)}
        </View>
      )}
    </TouchableOpacity>
  );
};
