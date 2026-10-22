import type { Api } from "@jellyfin/sdk";
import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client/models";
import { IMAGE_QUALITY } from "@/constants/Images";
import { getPrimaryImageUrl } from "./getPrimaryImageUrl";
import { cardImageWidth } from "./imagePixels";

/**
 * Where a landscape card's episode artwork comes from, in fallback order:
 * the series' thumb, then its backdrop, then the episode's own still, then a
 * tagless series-thumb request for episodes carrying no artwork fields at
 * all (their own Primary 404s, the series' usually does not).
 */
const episodeArtwork = (
  item: BaseItemDto,
  preferEpisodeImage: boolean,
): {
  itemId: string;
  imageType: "Primary" | "Thumb" | "Backdrop";
  tag?: string | null;
} | null => {
  if (preferEpisodeImage && item.Id && item.ImageTags?.Primary) {
    return {
      itemId: item.Id,
      imageType: "Primary",
      tag: item.ImageTags.Primary,
    };
  }
  // Matched pair: ParentThumbItemId owns the Thumb tag, not ParentBackdropItemId.
  if (item.ParentThumbItemId && item.ParentThumbImageTag) {
    return {
      itemId: item.ParentThumbItemId,
      imageType: "Thumb",
      tag: item.ParentThumbImageTag,
    };
  }
  const parentBackdropTag = item.ParentBackdropImageTags?.[0];
  if (item.ParentBackdropItemId && parentBackdropTag) {
    return {
      itemId: item.ParentBackdropItemId,
      imageType: "Backdrop",
      tag: parentBackdropTag,
    };
  }
  if (item.Id && item.ImageTags?.Primary) {
    return {
      itemId: item.Id,
      imageType: "Primary",
      tag: item.ImageTags.Primary,
    };
  }
  if (item.SeriesId) {
    return { itemId: item.SeriesId, imageType: "Thumb" };
  }
  return null;
};

/**
 * Artwork for a TV poster card, requested at the size the card is drawn.
 *
 * A landscape card prefers wide artwork: an episode shows its series' thumb,
 * then its series' backdrop, then its own still (first, with
 * `preferEpisodeImage`); anything else shows its thumb, then its primary
 * image. A portrait card shows the primary image, an episode its series'.
 *
 * @param widthPoints - The card's width in layout points.
 */
export const getTVPosterImageUrl = ({
  api,
  item,
  orientation,
  widthPoints,
  preferEpisodeImage = false,
}: {
  api?: Api | null;
  item: BaseItemDto;
  orientation: "vertical" | "horizontal";
  widthPoints: number;
  preferEpisodeImage?: boolean;
}): string | null => {
  if (!api) return null;

  const imageWidth = cardImageWidth(widthPoints);

  if (orientation === "horizontal") {
    const box = `fillWidth=${imageWidth}&fillHeight=${Math.round((imageWidth * 9) / 16)}&quality=${IMAGE_QUALITY}`;
    const image = (itemId: string, type: string, tag?: string | null) =>
      `${api.basePath}/Items/${itemId}/Images/${type}?${box}${tag ? `&tag=${tag}` : ""}`;

    if (item.Type === "Episode") {
      const artwork = episodeArtwork(item, preferEpisodeImage);
      if (artwork) return image(artwork.itemId, artwork.imageType, artwork.tag);
      return image(item.Id!, "Primary", item.ImageTags?.Primary);
    }

    if (item.ImageTags?.Thumb) {
      return image(item.Id!, "Thumb", item.ImageTags.Thumb);
    }
    return image(item.Id!, "Primary", item.ImageTags?.Primary);
  }

  if (item.Type === "Episode" && item.SeriesId && item.SeriesPrimaryImageTag) {
    // The same request the series' own card makes, so the two share one image.
    return `${api.basePath}/Items/${item.SeriesId}/Images/Primary?fillWidth=${imageWidth}&quality=${IMAGE_QUALITY}&tag=${item.SeriesPrimaryImageTag}`;
  }

  return getPrimaryImageUrl({ api, item, width: imageWidth });
};
