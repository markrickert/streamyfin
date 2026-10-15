import type { Api } from "@jellyfin/sdk";
import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client/models";
import { getPrimaryImageUrl } from "./getPrimaryImageUrl";
import { cardImageWidth } from "./imagePixels";

/**
 * Artwork for a TV poster card, requested at the size the card is drawn.
 *
 * A landscape card prefers wide artwork: an episode shows its series' thumb,
 * then its series' backdrop, then its own still (first, with
 * `preferEpisodeImage`); anything else shows its thumb, then its primary
 * image. A portrait card shows the primary image, an episode its series'.
 *
 * @param width - The card's width in layout points.
 */
export const getTVPosterImageUrl = ({
  api,
  item,
  orientation,
  width,
  preferEpisodeImage = false,
}: {
  api?: Api | null;
  item: BaseItemDto;
  orientation: "vertical" | "horizontal";
  width: number;
  preferEpisodeImage?: boolean;
}): string | null => {
  if (!api) return null;

  const imageWidth = cardImageWidth(width);

  if (orientation === "horizontal") {
    const box = `fillWidth=${imageWidth}&fillHeight=${Math.round((imageWidth * 9) / 16)}&quality=80`;
    const image = (itemId: string, type: string, tag?: string | null) =>
      `${api.basePath}/Items/${itemId}/Images/${type}?${box}${tag ? `&tag=${tag}` : ""}`;

    if (item.Type === "Episode") {
      if (preferEpisodeImage && item.ImageTags?.Primary) {
        return image(item.Id!, "Primary", item.ImageTags.Primary);
      }
      // Matched pair: ParentThumbItemId owns the Thumb tag, not ParentBackdropItemId.
      if (item.ParentThumbItemId && item.ParentThumbImageTag) {
        return image(item.ParentThumbItemId, "Thumb", item.ParentThumbImageTag);
      }
      const parentBackdropTag = item.ParentBackdropImageTags?.[0];
      if (item.ParentBackdropItemId && parentBackdropTag) {
        return image(item.ParentBackdropItemId, "Backdrop", parentBackdropTag);
      }
      return image(item.Id!, "Primary", item.ImageTags?.Primary);
    }

    if (item.ImageTags?.Thumb) {
      return image(item.Id!, "Thumb", item.ImageTags.Thumb);
    }
    return image(item.Id!, "Primary");
  }

  if (item.Type === "Episode" && item.SeriesId && item.SeriesPrimaryImageTag) {
    // The same request the series' own card makes, so the two share one image.
    return `${api.basePath}/Items/${item.SeriesId}/Images/Primary?fillWidth=${imageWidth}&quality=80&tag=${item.SeriesPrimaryImageTag}`;
  }

  return getPrimaryImageUrl({ api, item, width: imageWidth });
};
