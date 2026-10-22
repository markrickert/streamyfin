import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client/models";
import { useAtomValue } from "jotai";
import { useMemo } from "react";
import { useWindowDimensions } from "react-native";
import { apiAtom } from "@/providers/JellyfinProvider";
import { getBackdropUrl } from "@/utils/jellyfin/image/getBackdropUrl";

/**
 * Request an item's backdrop at the pixels of the box it covers. The box
 * defaults to the window — a backdrop usually fills the screen. Override a
 * side in layout points when it draws smaller.
 */
export const useBackdropUrl = (
  item: BaseItemDto | null | undefined,
  box?: {
    widthPoints?: number;
    heightPoints?: number;
    quality?: number;
  },
): string | null => {
  const api = useAtomValue(apiAtom);
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();

  const widthPoints = box?.widthPoints ?? windowWidth;
  const heightPoints = box?.heightPoints ?? windowHeight;
  const quality = box?.quality;

  return useMemo(
    () => getBackdropUrl({ api, item, widthPoints, heightPoints, quality }),
    [api, item, widthPoints, heightPoints, quality],
  );
};
