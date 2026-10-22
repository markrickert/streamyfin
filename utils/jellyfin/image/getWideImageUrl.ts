import type { Api } from "@jellyfin/sdk";
import {
  type BaseItemDto,
  ImageType,
} from "@jellyfin/sdk/lib/generated-client/models";
import { IMAGE_QUALITY } from "@/constants/Images";
import { cardImageWidth } from "./imagePixels";
import { imageUrl } from "./imageUrl";
import { resolveArtwork } from "./resolveArtwork";

/**
 * Build a landscape (16:9-ish) card image URL through the `wideCard`
 * chain — the Thumb when the item has one, failing over to Primary.
 *
 * @param useEpisodePoster - Prefer the episode's own still over the series
 *   Thumb for episodes (the `useEpisodeImagesForNextUp` setting).
 * @param widthPoints - The card's width in layout points; the request asks
 *   for the pixels that covers.
 */
export const getWideImageUrl = ({
  api,
  item,
  useEpisodePoster = false,
  widthPoints,
  quality = IMAGE_QUALITY,
}: {
  api?: Api | null;
  item?: BaseItemDto | null;
  useEpisodePoster?: boolean;
  widthPoints: number;
  quality?: number;
}): string | null => {
  if (!api || !item?.Id) return null;

  const artwork = resolveArtwork(item, "wideCard", {
    preferEpisodeImage: useEpisodePoster,
  });
  if (!artwork) return null;

  const widthPx = cardImageWidth(widthPoints);
  const heightPx = Math.round((widthPx * 9) / 16);
  // A Thumb spans the card's width, so ask by height alone. A Primary
  // keeps the artwork's own shape — a 2:3 poster asked by height alone
  // returns far too narrow — so it asks by width too.
  const box =
    artwork.imageType === ImageType.Thumb
      ? { fillHeightPx: heightPx, quality }
      : { fillWidthPx: widthPx, fillHeightPx: heightPx, quality };
  return imageUrl(api, artwork, box);
};
