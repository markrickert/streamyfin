import type { Api } from "@jellyfin/sdk";
import {
  type BaseItemDto,
  ImageType,
} from "@jellyfin/sdk/lib/generated-client/models";
import { IMAGE_QUALITY } from "@/constants/Images";
import { imageUrl, pointsBox } from "./imageUrl";

/**
 * Build the parent's backdrop URL — the series backdrop for an episode or
 * a season.
 *
 * @param api - The Jellyfin API instance.
 * @param item - The media item to retrieve the backdrop image URL for.
 * @param quality - The desired image quality.
 * @param widthPoints - The width the backdrop draws at, in layout
 *   points; the request asks for the pixels that covers.
 * @param heightPoints - The height of the box the backdrop covers, in
 *   layout points — pass it whenever the image draws cover fit.
 */
export const getParentBackdropImageUrl = ({
  api,
  item,
  quality = IMAGE_QUALITY,
  widthPoints,
  heightPoints,
}: {
  api?: Api | null;
  item?: BaseItemDto | null;
  quality?: number | null;
  widthPoints?: number | null;
  heightPoints?: number | null;
}) => {
  const parentId = item?.ParentBackdropItemId;
  if (!api || !parentId) {
    return null;
  }

  return imageUrl(
    api,
    {
      itemId: parentId,
      imageType: ImageType.Backdrop,
      tag: item?.ParentBackdropImageTags?.[0],
      index: 0,
    },
    {
      ...pointsBox({ widthPoints, heightPoints }),
      quality: quality ?? IMAGE_QUALITY,
    },
  );
};
