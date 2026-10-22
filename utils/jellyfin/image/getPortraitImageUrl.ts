import type { Api } from "@jellyfin/sdk";
import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client/models";
import { cardImageWidth } from "./imagePixels";
import { imageUrl } from "./imageUrl";
import { resolveArtwork } from "./resolveArtwork";

/**
 * Build a portrait (10:15) poster URL through the `portraitCard` chain: an
 * episode has no poster of its own, so it borrows its series' primary
 * image — what a vertical row of episodes is expected to show.
 *
 * @param widthPoints - The card's width in layout points; the request asks
 *   for the pixels that covers.
 */
export const getPortraitImageUrl = ({
  api,
  item,
  widthPoints,
}: {
  api?: Api | null;
  item?: BaseItemDto | null;
  widthPoints: number;
}): string | null =>
  imageUrl(api, resolveArtwork(item, "portraitCard"), {
    fillWidthPx: cardImageWidth(widthPoints),
  });
