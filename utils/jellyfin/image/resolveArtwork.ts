import {
  type BaseItemDto,
  ImageType,
} from "@jellyfin/sdk/lib/generated-client/models";
import type { Artwork } from "./imageUrl";

/**
 * Pick the artwork an item shows on a surface, in fallback order.
 *
 * The chain is the surface's contract, not the platform's: TV discovery
 * runs on TV but uses card-landscape sources, and the TV card cascade is a
 * superset of the mobile card's. Every entry is a matched pair — `itemId`,
 * `imageType` and `tag` owned by the same field set. A Thumb tag must never
 * be requested against the backdrop owner: it 404s, and that bug shipped
 * once as black cards.
 *
 * - `tvCardLandscape`: episode → own still (with preferEpisodeImage) → series
 *   Thumb → series Backdrop → own still → tagless series Thumb (the episode's
 *   own Primary 404s, the series' usually does not) → tagless own Primary.
 *   Non-episode → own Thumb → own Primary.
 * - `wideCard`: episode → own Primary with preferEpisodeImage, else series
 *   Thumb → own Primary. Non-episode → own Thumb → own Primary. The mobile
 *   card skips the series-backdrop stop — a wide row falls back on the
 *   still.
 * - `portraitCard`: episode → series Primary, and only when its tag exists.
 *   Never send a request the server can't fulfil; else own Primary.
 *   Non-episode → own Primary.
 * - `discoveryLandscape`: tag-verified artwork only. The chain ends in null
 *   rather than a speculative request: a tile whose URL 404s renders broken
 *   instead of empty.
 * - `discoveryPoster`: episode → season Primary → series Primary → own
 *   Primary, all tag-verified. Non-episode → own Primary.
 * - `primary`: the item's own Primary — no episode special-casing. The
 *   chain behind `getPrimaryImageUrl`.
 */
export type ArtworkChain =
  | "tvCardLandscape"
  | "wideCard"
  | "portraitCard"
  | "discoveryLandscape"
  | "discoveryPoster"
  | "primary";

/** The item's own Primary, only when its tag is known — an episode's still. */
const ownPrimaryTagged = (item: BaseItemDto): Artwork | null =>
  item.Id && item.ImageTags?.Primary
    ? {
        itemId: item.Id,
        imageType: ImageType.Primary,
        tag: item.ImageTags.Primary,
      }
    : null;

/** The item's own Primary; the request is speculative without a tag. */
const ownPrimary = (item: BaseItemDto): Artwork | null =>
  item.Id
    ? {
        itemId: item.Id,
        imageType: ImageType.Primary,
        tag: item.ImageTags?.Primary,
      }
    : null;

const ownThumb = (item: BaseItemDto): Artwork | null =>
  item.Id && item.ImageTags?.Thumb
    ? { itemId: item.Id, imageType: ImageType.Thumb, tag: item.ImageTags.Thumb }
    : null;

// Matched pair: `ParentThumbItemId` owns the Thumb tag — never `ParentBackdropItemId`.
const parentThumb = (item: BaseItemDto): Artwork | null =>
  item.ParentThumbItemId && item.ParentThumbImageTag
    ? {
        itemId: item.ParentThumbItemId,
        imageType: ImageType.Thumb,
        tag: item.ParentThumbImageTag,
      }
    : null;

const parentBackdrop = (item: BaseItemDto): Artwork | null => {
  const tag = item.ParentBackdropImageTags?.[0];
  return item.ParentBackdropItemId && tag
    ? { itemId: item.ParentBackdropItemId, imageType: ImageType.Backdrop, tag }
    : null;
};

// Ask tagless by design: the episode's own Primary 404s, the series'
// Thumb usually does not.
const seriesThumbTagless = (item: BaseItemDto): Artwork | null =>
  item.SeriesId ? { itemId: item.SeriesId, imageType: ImageType.Thumb } : null;

const seriesPrimary = (item: BaseItemDto): Artwork | null =>
  item.SeriesId && item.SeriesPrimaryImageTag
    ? {
        itemId: item.SeriesId,
        imageType: ImageType.Primary,
        tag: item.SeriesPrimaryImageTag,
      }
    : null;

// Matched pair for an episode's direct parent — the season.
const seasonPrimary = (item: BaseItemDto): Artwork | null =>
  item.SeasonId && item.ParentPrimaryImageTag
    ? {
        itemId: item.SeasonId,
        imageType: ImageType.Primary,
        tag: item.ParentPrimaryImageTag,
      }
    : null;

// Carry whichever tag the item offers — `getPrimaryImageUrl`'s
// long-standing behaviour.
const ownPrimaryAnyTag = (item: BaseItemDto): Artwork | null =>
  item.Id
    ? {
        itemId: item.Id,
        imageType: ImageType.Primary,
        tag:
          item.ImageTags?.Primary ??
          item.BackdropImageTags?.[0] ??
          item.ParentBackdropImageTags?.[0],
      }
    : null;

type Candidate = (item: BaseItemDto) => Artwork | null;

const pick = (item: BaseItemDto, candidates: (Candidate | null)[]) => {
  for (const candidate of candidates) {
    const artwork = candidate?.(item);
    if (artwork) return artwork;
  }
  return null;
};

export const resolveArtwork = (
  item: BaseItemDto | null | undefined,
  chain: ArtworkChain,
  { preferEpisodeImage = false }: { preferEpisodeImage?: boolean } = {},
): Artwork | null => {
  if (!item) return null;
  const episode = item.Type === "Episode";

  switch (chain) {
    case "tvCardLandscape":
      return episode
        ? pick(item, [
            preferEpisodeImage ? ownPrimaryTagged : null,
            parentThumb,
            parentBackdrop,
            ownPrimaryTagged,
            seriesThumbTagless,
            ownPrimary,
          ])
        : pick(item, [ownThumb, ownPrimary]);
    case "wideCard":
      if (episode) {
        return preferEpisodeImage
          ? ownPrimary(item)
          : pick(item, [parentThumb, ownPrimary]);
      }
      return pick(item, [ownThumb, ownPrimary]);
    case "portraitCard":
      return pick(item, [episode ? seriesPrimary : null, ownPrimaryAnyTag]);
    case "discoveryLandscape":
      return episode
        ? preferEpisodeImage
          ? ownPrimaryTagged(item)
          : parentThumb(item)
        : pick(item, [ownThumb, ownPrimaryTagged]);
    case "discoveryPoster":
      return episode && !preferEpisodeImage
        ? pick(item, [seasonPrimary, seriesPrimary, ownPrimaryTagged])
        : ownPrimaryTagged(item);
    case "primary":
      return ownPrimaryAnyTag(item);
  }
};
