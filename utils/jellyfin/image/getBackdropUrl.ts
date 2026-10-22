import type { Api } from "@jellyfin/sdk";
import {
  type BaseItemDto,
  ImageType,
} from "@jellyfin/sdk/lib/generated-client/models";
import { IMAGE_QUALITY } from "@/constants/Images";
import { getPrimaryImageUrl } from "./getPrimaryImageUrl";
import { imageUrl, pointsBox } from "./imageUrl";

/**
 * Build the item's backdrop URL, falling back to its primary image when it
 * has no backdrop.
 *
 * @param api - The Jellyfin API instance.
 * @param item - The media item to retrieve the backdrop image URL for.
 * @param quality - The desired image quality.
 * @param widthPoints - The width the backdrop draws at, in layout points;
 *   the request asks for the pixels that covers.
 * @param heightPoints - The height of the box the backdrop covers, in
 *   layout points — pass it whenever the image draws cover fit.
 */
export const getBackdropUrl = ({
  api,
  item,
  quality = IMAGE_QUALITY,
  widthPoints,
  heightPoints,
}: {
  api?: Api | null;
  item?: BaseItemDto | null;
  quality?: number;
  widthPoints?: number;
  heightPoints?: number;
}) => {
  if (!api || !item) {
    return null;
  }

  const backdropImageTag = item.BackdropImageTags?.[0];

  if (item.Type === "Episode" || !item.Id || !backdropImageTag) {
    return getPrimaryImageUrl({
      api,
      item,
      quality,
      widthPoints,
      heightPoints,
    });
  }

  return imageUrl(
    api,
    {
      itemId: item.Id,
      imageType: ImageType.Backdrop,
      tag: backdropImageTag,
      index: 0,
    },
    { ...pointsBox({ widthPoints, heightPoints }), quality },
  );
};
