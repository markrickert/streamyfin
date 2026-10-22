import type { Api } from "@jellyfin/sdk";
import {
  type BaseItemDto,
  type BaseItemPerson,
  ImageType,
} from "@jellyfin/sdk/lib/generated-client/models";
import { IMAGE_QUALITY } from "@/constants/Images";
import { isBaseItemDto } from "../jellyfin";
import { imageUrl, pointsBox } from "./imageUrl";
import { resolveArtwork } from "./resolveArtwork";

/**
 * Build the item's primary image URL.
 *
 * @param api - The Jellyfin API instance.
 * @param item - The media item to retrieve the primary image URL for.
 * @param quality - The desired image quality.
 * @param widthPoints - The width the image draws at, in layout points;
 *   the request asks for the pixels that covers.
 * @param heightPoints - The height of the box the image covers, in layout
 *   points — pass it whenever the image draws cover fit.
 */
export const getPrimaryImageUrl = ({
  api,
  item,
  quality = IMAGE_QUALITY,
  widthPoints,
  heightPoints,
}: {
  api?: Api | null;
  item?: BaseItemDto | BaseItemPerson | null;
  quality?: number | null;
  widthPoints?: number | null;
  heightPoints?: number | null;
}) => {
  if (!item || !api) {
    return null;
  }

  const box = {
    ...pointsBox({ widthPoints, heightPoints }),
    quality: quality ?? IMAGE_QUALITY,
  };

  // A person carries no artwork fields; its primary image is the only one.
  if (!isBaseItemDto(item)) {
    return item.Id
      ? imageUrl(api, { itemId: item.Id, imageType: ImageType.Primary }, box)
      : null;
  }

  return imageUrl(api, resolveArtwork(item, "primary"), box);
};
