import { Ionicons } from "@expo/vector-icons";
import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client/models";
import type { ImageProps } from "expo-image";
import { useAtom } from "jotai";
import { type FC, useMemo } from "react";
import { useWindowDimensions, View, type ViewProps } from "react-native";
import { Image } from "@/components/common/ServerImage";
import { BACKGROUND_IMAGE_TRANSITION } from "@/constants/Values";
import { apiAtom } from "@/providers/JellyfinProvider";
import { getArtwork } from "@/utils/jellyfin/image/artwork";

interface Props extends ImageProps {
  item: BaseItemDto;
  purpose?: "portrait" | "backdrop";
  /**
   * Rendered image box in layout points. Defaults to the window for
   * full-screen art.
   */
  box?: { width: number; height: number };
  onError?: () => void;
}

export const ItemImage: FC<Props> = ({
  item,
  purpose = "portrait",
  box,
  onError,
  ...props
}) => {
  const [api] = useAtom(apiAtom);
  const window = useWindowDimensions();

  const source = useMemo(() => {
    if (!api) {
      onError?.();
      return;
    }
    return getArtwork({
      api,
      item,
      purpose,
      box: box ?? { width: window.width, height: window.height },
    });
  }, [
    api,
    item,
    purpose,
    box?.width,
    box?.height,
    window.width,
    window.height,
  ]);

  // return placeholder icon if no source
  if (!source?.uri)
    return (
      <View
        {...(props as ViewProps)}
        className='flex flex-col items-center justify-center border border-neutral-800 bg-neutral-900'
      >
        <Ionicons
          name='image-outline'
          size={24}
          color='white'
          style={{ opacity: 0.4 }}
        />
      </View>
    );

  return (
    <Image
      cachePolicy={"memory-disk"}
      transition={BACKGROUND_IMAGE_TRANSITION}
      placeholder={{
        blurhash: source?.blurhash,
      }}
      style={{
        width: "100%",
        height: "100%",
      }}
      // Pass the uri only: ServerImage resolves the server's proxy auth headers
      // from it (and re-resolves them when the custom headers change).
      source={source?.uri}
      {...props}
    />
  );
};
