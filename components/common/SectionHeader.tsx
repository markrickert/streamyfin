import { TouchableOpacity, View } from "react-native";
import { Colors } from "@/constants/Colors";
import { Text } from "./Text";

type Props = {
  title: string;
  actionLabel?: string;
  actionDisabled?: boolean;
  onPressAction?: () => void;
  /** Drawn at the end of the row — a count pill, a small action. */
  accessory?: React.ReactNode;
};

export const SectionHeader: React.FC<Props> = ({
  title,
  actionLabel,
  actionDisabled = false,
  onPressAction,
  accessory,
}) => {
  const shouldShowAction = Boolean(actionLabel) && Boolean(onPressAction);

  return (
    <View className='px-4 flex flex-row items-center justify-between mb-2'>
      <Text className='text-lg font-bold text-foreground'>{title}</Text>
      {accessory}
      {shouldShowAction && (
        <TouchableOpacity
          onPress={onPressAction}
          disabled={actionDisabled}
          accessibilityRole='button'
          accessibilityLabel={actionLabel}
          className='py-1 pl-3'
        >
          <Text
            style={{
              color: actionDisabled
                ? Colors.foregroundDisabled
                : Colors.primary,
            }}
          >
            {actionLabel}
          </Text>
        </TouchableOpacity>
      )}
    </View>
  );
};
