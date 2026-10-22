import type { Api } from "@jellyfin/sdk";
import {
  type BaseItemDto,
  ImageType,
} from "@jellyfin/sdk/lib/generated-client/models";
import type { ImageSource } from "expo-image";
import { getJellyfinHeadersForUrl } from "@/utils/customHeaders";
import {
  type Artwork,
  coverBox,
  imageUrl,
} from "@/utils/jellyfin/image/imageUrl";

interface Props {
  item: BaseItemDto;
  api: Api;
  quality?: number;
  /** Image width in physical pixels, not layout points. */
  widthPx?: number;
  /**
   * Height of the box the image covers, in physical pixels. With it the
   * request covers a `widthPx` by `heightPx` box instead of a fixed width.
   */
  heightPx?: number;
  variant?:
    | "Primary"
    | "Backdrop"
    | "ParentBackdrop"
    | "ParentLogo"
    | "Logo"
    | "AlbumPrimary"
    | "SeriesPrimary"
    | "Screenshot"
    | "Thumb";
}

export const getItemImage = ({
  item,
  api,
  variant = "Primary",
  quality = 90,
  widthPx = 1000,
  heightPx,
}: Props) => {
  if (!api) return null;

  const size = heightPx
    ? coverBox({ fillWidthPx: widthPx, fillHeightPx: heightPx })
    : { widthPx };

  let artwork: Artwork | null = null;
  let blurhash: string | null | undefined;

  switch (variant) {
    case "Backdrop": {
      if (item.Type === "Episode") {
        const tag = item.ParentBackdropImageTags?.[0];
        if (!item.ParentBackdropItemId || !tag) break;
        blurhash = item.ImageBlurHashes?.Backdrop?.[tag];
        artwork = {
          itemId: item.ParentBackdropItemId,
          imageType: ImageType.Backdrop,
          tag,
          index: 0,
        };
        break;
      }

      const tag = item.BackdropImageTags?.[0];
      if (!item.Id || !tag) break;
      blurhash = item.ImageBlurHashes?.Backdrop?.[tag];
      artwork = {
        itemId: item.Id,
        imageType: ImageType.Backdrop,
        tag,
        index: 0,
      };
      break;
    }
    case "Primary":
      if (!item.Id || !item.ImageTags?.Primary) break;
      blurhash = item.ImageBlurHashes?.Primary?.[item.ImageTags.Primary];
      artwork = {
        itemId: item.Id,
        imageType: ImageType.Primary,
        tag: item.ImageTags.Primary,
      };
      break;
    case "Thumb":
      if (!item.Id || !item.ImageTags?.Thumb) break;
      blurhash = item.ImageBlurHashes?.Thumb?.[item.ImageTags.Thumb];
      artwork = {
        itemId: item.Id,
        imageType: ImageType.Thumb,
        tag: item.ImageTags.Thumb,
      };
      break;
    default:
      if (!item.Id) break;
      artwork = {
        itemId: item.Id,
        imageType: ImageType.Primary,
        tag: item.ImageTags?.Primary,
      };
      break;
  }

  const uri = artwork && imageUrl(api, artwork, { ...size, quality });
  if (!uri) return null;

  // The consumers pass this straight to expo-image or download it, so the
  // proxy auth headers have to travel with the source rather than be added by
  // the <Image> wrapper.
  const headers = getJellyfinHeadersForUrl(uri, api.basePath);
  const src: ImageSource = { uri, blurhash: blurhash ?? undefined };
  return headers ? { ...src, headers } : src;
};
