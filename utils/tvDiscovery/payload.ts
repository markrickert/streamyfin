import type { Api } from "@jellyfin/sdk";
import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client/models";
import i18next from "i18next";
import { PixelRatio } from "react-native";
import {
  TV_LAUNCHER_POSTER_HEIGHT_PX,
  TV_LAUNCHER_POSTER_WIDTH_PX,
  TV_LAUNCHER_WIDE_HEIGHT_PX,
  TV_LAUNCHER_WIDE_WIDTH_PX,
} from "@/constants/TVDiscovery";
import { getArtwork } from "@/utils/jellyfin/image/artwork";
import { isPlayableItem } from "@/utils/jellyfin/media/isPlayableItem";

const TV_DISCOVERY_ITEM_LIMIT = 12;
const TV_DISCOVERY_SECTION_LIMIT = 3;

export interface TVDiscoveryItem {
  id: string;
  itemType?: string;
  title: string;
  subtitle?: string;
  imageUrl?: string;
  /** Opens the item's page: the Select action on a Top Shelf tile. */
  route: string;
  /**
   * What Play does: the Play button on a Top Shelf tile, and the tile itself
   * on Android TV, where a preview program has a single intent. The player for
   * an item that has a stream, the same page as `route` for a container.
   */
  playRoute?: string;
}

/**
 * Apple TV renders Top Shelf items as 2:3 posters. The refreshed Google TV home
 * ignores poster_art_aspect_ratio and forces its own landscape tile shape,
 * cropping portrait posters — so Android gets pre-shaped landscape backdrops
 * instead. Each platform requests art matching the surface it displays on.
 */
export type TVDiscoveryImageShape = "poster" | "landscape";

export interface TVDiscoverySection {
  title: string;
  items: TVDiscoveryItem[];
}

export interface TVDiscoveryPayload {
  version: 1;
  updatedAt: string;
  sections: TVDiscoverySection[];
}

function getTVDiscoveryImage(
  item: BaseItemDto,
  api: Api,
  shape: TVDiscoveryImageShape,
  useEpisodeImages: boolean,
): { url: string } | undefined {
  const density = PixelRatio.get();
  const poster = shape === "poster";
  const artwork = getArtwork({
    api,
    item,
    purpose: poster ? "portrait" : "wide",
    box: poster
      ? {
          width: TV_LAUNCHER_POSTER_WIDTH_PX / density,
          height: TV_LAUNCHER_POSTER_HEIGHT_PX / density,
        }
      : {
          width: TV_LAUNCHER_WIDE_WIDTH_PX / density,
          height: TV_LAUNCHER_WIDE_HEIGHT_PX / density,
        },
    preferEpisodeImage: !poster && useEpisodeImages,
    portraitCover: poster,
  });
  return artwork?.uri ? { url: artwork.uri } : undefined;
}

function formatEpisodeNumber(item: BaseItemDto): string | undefined {
  const season = item.ParentIndexNumber;
  const episode = item.IndexNumber;

  if (season != null && episode != null) {
    return `S${season} • E${episode}`;
  }

  if (season != null) {
    return i18next.t("seerr.season_number", { season_number: season });
  }
  if (episode != null) {
    return i18next.t("item_card.episode_number", { episode_number: episode });
  }

  return undefined;
}

function getTVDiscoveryTitle(item: BaseItemDto): string {
  if (item.Type === "Episode") {
    const episodeNumber = formatEpisodeNumber(item);

    if (item.SeriesName && episodeNumber) {
      return `${item.SeriesName} - ${episodeNumber}`;
    }

    if (item.SeriesName) return item.SeriesName;
    if (episodeNumber) return episodeNumber;
    return item.Name || "";
  }

  return item.Name || "";
}

function getTVDiscoverySubtitle(item: BaseItemDto): string | undefined {
  if (item.Type === "Episode") return undefined;

  return item.ProductionYear ? String(item.ProductionYear) : item.Type;
}

function getTVDiscoveryRoute(item: BaseItemDto): string {
  const params = [
    `id=${encodeURIComponent(item.Id!)}`,
    `type=${encodeURIComponent(item.Type || "")}`,
  ];

  // A season has no page of its own: the app shows it as the series page with
  // that season selected, so the link has to say which series and which one.
  if (item.Type === "Season" && item.SeriesId) {
    params.push(`seriesId=${encodeURIComponent(item.SeriesId)}`);
    if (item.IndexNumber != null) {
      params.push(`seasonIndex=${item.IndexNumber}`);
    }
  }

  return `streamyfin://topshelf/item?${params.join("&")}`;
}

function getTVDiscoveryPlayRoute(item: BaseItemDto, route: string): string {
  // The play link carries nothing but an id, and the player asks the server
  // for a stream of exactly that id. A series or a season has none, so Play
  // opens its page instead, where the app picks the episode to continue with.
  // Pointing at the page rather than leaving the action out keeps the Play
  // button on the remote from being a dead key on those tiles.
  if (!isPlayableItem(item)) return route;

  return `streamyfin://topshelf/play?id=${encodeURIComponent(item.Id!)}`;
}

function sectionFromItems(
  title: string,
  items: BaseItemDto[] | undefined,
  api: Api,
  shape: TVDiscoveryImageShape,
  useEpisodeImages: boolean,
): TVDiscoverySection | null {
  const payloadItems = (items || [])
    .filter((item) => item.Id && item.Name)
    .slice(0, TV_DISCOVERY_ITEM_LIMIT)
    .map((item) => {
      const image = getTVDiscoveryImage(item, api, shape, useEpisodeImages);
      const route = getTVDiscoveryRoute(item);
      return {
        id: item.Id!,
        itemType: item.Type || undefined,
        title: getTVDiscoveryTitle(item),
        subtitle: getTVDiscoverySubtitle(item),
        imageUrl: image?.url,
        route,
        playRoute: getTVDiscoveryPlayRoute(item, route),
      };
    });

  if (payloadItems.length === 0) return null;

  return {
    title,
    items: payloadItems,
  };
}

export function buildTVDiscoveryPayload({
  api,
  sections,
  imageShape,
  useEpisodeImages,
}: {
  api: Api | null | undefined;
  sections: Array<{ title: string; items: BaseItemDto[] | undefined }>;
  imageShape?: TVDiscoveryImageShape;
  useEpisodeImages?: boolean;
}): TVDiscoveryPayload | null {
  if (!api) return null;

  const shape: TVDiscoveryImageShape = imageShape ?? "poster";
  const episodeImages = useEpisodeImages ?? false;

  const payloadSections = sections
    .map((section) =>
      sectionFromItems(section.title, section.items, api, shape, episodeImages),
    )
    .filter((section): section is TVDiscoverySection => section !== null)
    .slice(0, TV_DISCOVERY_SECTION_LIMIT);

  if (payloadSections.length === 0) return null;

  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    sections: payloadSections,
  };
}
