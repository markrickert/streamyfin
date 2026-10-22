import type { Api } from "@jellyfin/sdk";
import {
  type BaseItemDto,
  ImageType,
} from "@jellyfin/sdk/lib/generated-client/models";
import { IMAGE_QUALITY } from "@/constants/Images";
import { getPrimaryImageUrl } from "./getPrimaryImageUrl";
import { cardImageWidth, landscapeBoxQuery } from "./imagePixels";

type Artwork = {
  itemId: string;
  imageType: ImageType;
  tag?: string | null;
};

/**
 * Where a landscape card's episode artwork comes from, in fallback order:
 * the series' thumb, then its backdrop, then the episode's own still (first,
 * with `preferEpisodeImage`), then a tagless series-thumb request for
 * episodes carrying no artwork fields at all (their own Primary 404s, the
 * series' usually does not).
 */
const episodeArtwork = (
  item: BaseItemDto,
  preferEpisodeImage: boolean,
): Artwork => {
  const still: Artwork | null =
    item.Id && item.ImageTags?.Primary
      ? {
          itemId: item.Id,
          imageType: ImageType.Primary,
          tag: item.ImageTags.Primary,
        }
      : null;
  if (preferEpisodeImage && still) return still;
  // Matched pair: ParentThumbItemId owns the Thumb tag, not ParentBackdropItemId.
  if (item.ParentThumbItemId && item.ParentThumbImageTag) {
    return {
      itemId: item.ParentThumbItemId,
      imageType: ImageType.Thumb,
      tag: item.ParentThumbImageTag,
    };
  }
  const parentBackdropTag = item.ParentBackdropImageTags?.[0];
  if (item.ParentBackdropItemId && parentBackdropTag) {
    return {
      itemId: item.ParentBackdropItemId,
      imageType: ImageType.Backdrop,
      tag: parentBackdropTag,
    };
  }
  if (still) return still;
  if (item.SeriesId)
    return { itemId: item.SeriesId, imageType: ImageType.Thumb };
  return { itemId: item.Id!, imageType: ImageType.Primary };
};

const landscapeUrl = (
  api: Api,
  { itemId, imageType, tag }: Artwork,
  widthPx: number,
) =>
  `${api.basePath}/Items/${itemId}/Images/${imageType}?${landscapeBoxQuery(widthPx)}${tag ? `&tag=${tag}` : ""}`;

/**
 * An episode's landscape artwork, picked as `episodeArtwork` does, covering a
 * 16:9 box this many pixels wide. For artwork drawn at a size of its own; a
 * card goes through `getTVPosterImageUrl`.
 */
export const getTVEpisodeArtworkUrl = ({
  api,
  item,
  widthPx,
  preferEpisodeImage = false,
}: {
  api?: Api | null;
  item: BaseItemDto;
  widthPx: number;
  preferEpisodeImage?: boolean;
}): string | null =>
  api
    ? landscapeUrl(api, episodeArtwork(item, preferEpisodeImage), widthPx)
    : null;

/**
 * Artwork for a TV poster card, requested at the size the card is drawn.
 *
 * A landscape card prefers wide artwork: an episode follows `episodeArtwork`,
 * anything else shows its thumb, then its primary image. A portrait card
 * shows the primary image, an episode its series'.
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
    const artwork: Artwork =
      item.Type === "Episode"
        ? episodeArtwork(item, preferEpisodeImage)
        : item.ImageTags?.Thumb
          ? {
              itemId: item.Id!,
              imageType: ImageType.Thumb,
              tag: item.ImageTags.Thumb,
            }
          : {
              itemId: item.Id!,
              imageType: ImageType.Primary,
              tag: item.ImageTags?.Primary,
            };
    return landscapeUrl(api, artwork, imageWidth);
  }

  if (item.Type === "Episode" && item.SeriesId && item.SeriesPrimaryImageTag) {
    // The same request the series' own card makes, so the two share one image.
    return `${api.basePath}/Items/${item.SeriesId}/Images/Primary?fillWidth=${imageWidth}&quality=${IMAGE_QUALITY}&tag=${item.SeriesPrimaryImageTag}`;
  }

  return getPrimaryImageUrl({ api, item, width: imageWidth });
};
