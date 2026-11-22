import { useTranslation } from "react-i18next";
import {
  HeaderButton,
  HeaderButtonGroup,
} from "@/components/common/HeaderButton";
import { HeaderIcon } from "@/components/common/HeaderIcon";
import { Colors } from "@/constants/Colors";

/** Tint of a header icon whose button cannot be pressed right now. */
const DISABLED_TINT = Colors.foregroundDisabled;

interface Props {
  onPlayAll: () => void;
  onShuffle: () => void;
  /** Nothing to queue, or a queue is already being fetched. */
  disabled: boolean;
}

/** Play All and Shuffle for the header of a library page. */
export const LibraryPlayButtons: React.FC<Props> = ({
  onPlayAll,
  onShuffle,
  disabled,
}) => {
  const { t } = useTranslation();
  const tintColor = disabled ? DISABLED_TINT : Colors.foreground;

  return (
    <HeaderButtonGroup>
      <HeaderButton
        onPress={onPlayAll}
        disabled={disabled}
        accessibilityRole='button'
        accessibilityLabel={t("library.play_all")}
      >
        <HeaderIcon name='play' tintColor={tintColor} />
      </HeaderButton>
      <HeaderButton
        onPress={onShuffle}
        disabled={disabled}
        accessibilityRole='button'
        accessibilityLabel={t("player.shuffle")}
      >
        <HeaderIcon name='shuffle' tintColor={tintColor} />
      </HeaderButton>
    </HeaderButtonGroup>
  );
};
