import type { Api } from "@jellyfin/sdk";
import {
  type BaseItemDto,
  ImageType,
} from "@jellyfin/sdk/lib/generated-client/models";
import { LOGO_HEIGHT, MAX_LOGO_HEIGHT_PX } from "@/constants/Images";
import { toImagePixels } from "./imagePixels";
import { imageUrl } from "./imageUrl";

/**
 * Build the item's logo URL. An episode has no logo of its own and gets
 * its series' logo.
 *
 * @param api - The Jellyfin API instance.
 * @param item - The media item to retrieve the logo image URL for.
 * @param heightPx - The image height in physical pixels, capped at
 *   `MAX_LOGO_HEIGHT_PX`. Defaults to the detail page logo slot on this
 *   screen.
 */
export const getLogoImageUrlById = ({
  api,
  item,
  heightPx = toImagePixels(LOGO_HEIGHT),
}: {
  api?: Api | null;
  item?: BaseItemDto | null;
  heightPx?: number;
}) => {
  if (!api || !item) {
    return null;
  }

  const box = {
    fillHeightPx: Math.min(Math.round(heightPx), MAX_LOGO_HEIGHT_PX),
    quality: 90,
  };

  if (item.Type === "Episode") {
    if (!item.ParentLogoItemId || !item.ParentLogoImageTag) {
      return null;
    }
    return imageUrl(
      api,
      {
        itemId: item.ParentLogoItemId,
        imageType: ImageType.Logo,
        tag: item.ParentLogoImageTag,
      },
      box,
    );
  }

  if (!item.Id || !item.ImageTags?.Logo) return null;
  return imageUrl(
    api,
    { itemId: item.Id, imageType: ImageType.Logo, tag: item.ImageTags.Logo },
    box,
  );
};
