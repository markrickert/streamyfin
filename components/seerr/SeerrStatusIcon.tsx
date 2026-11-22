import { MaterialCommunityIcons } from "@expo/vector-icons";
import { TouchableOpacity, View, type ViewProps } from "react-native";
import { Colors } from "@/constants/Colors";
import {
  type SeerrStatusTone,
  seerrStatusBadge,
} from "@/utils/seerr/statusBadge";
import { MediaStatus } from "@/utils/seerr/types";

interface Props {
  mediaStatus?: MediaStatus;
  showRequestIcon: boolean;
  onPress?: () => void;
  /** Drawn smaller, over a poster, so the poster shows. */
  small?: boolean;
}

// Seerr's colours for each tone (StatusBadgeMini); a season row lays its own
// background over the request "+" through className.
const TONE_CLASSES: Record<SeerrStatusTone, string> = {
  processing: "bg-info border-info-light ring-info-light text-foreground",
  available:
    "bg-primary border-success-light ring-success-light text-foreground",
  pending: "bg-warning border-warning-light ring-warning-light text-foreground",
  blocklisted: "bg-danger border-white-400 ring-white-400 text-foreground",
  partial: "bg-success border-success-light ring-success-light text-foreground",
  request: "bg-success",
};

const SeerrStatusIcon: React.FC<Props & ViewProps> = ({
  mediaStatus,
  showRequestIcon,
  onPress,
  small = false,
  ...props
}) => {
  // Derived on each render: set from an effect, the badge was never cleared
  // when a title went back to having none.
  const badge = seerrStatusBadge(mediaStatus, showRequestIcon);

  return (
    badge && (
      <TouchableOpacity onPress={onPress} disabled={onPress === undefined}>
        <View
          className={`${TONE_CLASSES[badge.tone]} rounded-full ${small ? "h-5 w-5" : "h-6 w-6"} flex items-center justify-center ${props.className}`}
          {...props}
        >
          <MaterialCommunityIcons
            name={badge.icon}
            size={small ? 14 : 18}
            color={Colors.foreground}
          />
        </View>
      </TouchableOpacity>
    )
  );
};

export default SeerrStatusIcon;
