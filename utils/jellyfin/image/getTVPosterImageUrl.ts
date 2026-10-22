import type { Api } from "@jellyfin/sdk";
import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client/models";
import { cardImageWidth, toImagePixels } from "./imagePixels";
import { imageUrl, landscapeBox } from "./imageUrl";
import { resolveArtwork } from "./resolveArtwork";

/**
 * Build an episode's landscape artwork URL through the `tvCardLandscape`
 * chain, covering a 16:9 box this many layout points wide. For artwork
 * drawn at a size of its own; a card goes through `getTVPosterImageUrl`.
 */
export const getTVEpisodeArtworkUrl = ({
  api,
  item,
  widthPoints,
  preferEpisodeImage = false,
}: {
  api?: Api | null;
  item: BaseItemDto;
  widthPoints: number;
  preferEpisodeImage?: boolean;
}): string | null =>
  imageUrl(
    api,
    resolveArtwork(item, "tvCardLandscape", { preferEpisodeImage }),
    landscapeBox(toImagePixels(widthPoints)),
  );

/**
 * Build a TV poster card's artwork URL at the size the card is drawn.
 *
 * A landscape card follows `tvCardLandscape`: an episode cascades through
 * still and series art, anything else shows its thumb then its primary.
 * A portrait card follows `portraitCard`: an episode shows its series'
 * poster.
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

  const widthPx = cardImageWidth(widthPoints);
  if (orientation === "horizontal") {
    return imageUrl(
      api,
      resolveArtwork(item, "tvCardLandscape", { preferEpisodeImage }),
      landscapeBox(widthPx),
    );
  }
  return imageUrl(api, resolveArtwork(item, "portraitCard"), {
    fillWidthPx: widthPx,
  });
};
