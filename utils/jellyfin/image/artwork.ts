import type { Api } from "@jellyfin/sdk";
import type {
  BaseItemDto,
  BaseItemPerson,
} from "@jellyfin/sdk/lib/generated-client/models";
import type { ImageSource } from "expo-image";
import { PixelRatio } from "react-native";
import {
  CARD_IMAGE_HEIGHT_STEP_PX,
  CARD_IMAGE_WIDTH_STEP_PX,
  FULLSCREEN_IMAGE_STEP_PX,
  MAX_FULLSCREEN_IMAGE_PIXELS,
  MAX_LOGO_HEIGHT_PX,
} from "@/constants/Images";
import { getJellyfinHeadersForUrl } from "@/utils/customHeaders";
import { toImagePixels } from "./imagePixels";
import { itemImageUrl } from "./itemImageUrl";

type ArtworkPurpose = "portrait" | "wide" | "backdrop" | "logo";
type SelectedArt = {
  id: string;
  type: "Primary" | "Thumb" | "Backdrop" | "Logo";
  tag: string;
};

export function getArtworkByOwner({
  api,
  id,
  type,
  tag,
  pixels,
  fit = false,
  quality = 80,
}: {
  api?: Api | null;
  id?: string | null;
  type: SelectedArt["type"];
  tag?: string | null;
  pixels: { width: number; height?: number };
  fit?: boolean;
  quality?: number;
}): ImageSource | null {
  if (
    !api ||
    !id ||
    !tag ||
    pixels.width <= 0 ||
    (pixels.height != null && pixels.height <= 0)
  ) {
    return null;
  }
  const uri = itemImageUrl(api, id, type, {
    ...(fit
      ? { maxWidth: pixels.width, maxHeight: pixels.height }
      : { fillWidth: pixels.width, fillHeight: pixels.height }),
    quality,
    tag,
    ...(type === "Backdrop" ? { imageIndex: 0 } : null),
  });
  const headers = getJellyfinHeadersForUrl(uri, api.basePath);
  return { uri, ...(headers ? { headers } : null) };
}

export function getPersonArtwork({
  api,
  person,
  box,
  focusScale = 1,
}: {
  api?: Api | null;
  person: BaseItemPerson;
  box: { width: number; height: number };
  focusScale?: number;
}): ImageSource | null {
  const width =
    Math.ceil(
      toImagePixels(box.width * focusScale) / CARD_IMAGE_WIDTH_STEP_PX,
    ) * CARD_IMAGE_WIDTH_STEP_PX;
  const height =
    Math.ceil(
      toImagePixels(box.height * focusScale) / CARD_IMAGE_HEIGHT_STEP_PX,
    ) * CARD_IMAGE_HEIGHT_STEP_PX;
  const source = getArtworkByOwner({
    api,
    id: person.Id,
    type: "Primary",
    tag: person.PrimaryImageTag,
    pixels: { width, height },
  });
  const blurhash = person.PrimaryImageTag
    ? (person.ImageBlurHashes?.Primary?.[person.PrimaryImageTag] ?? undefined)
    : undefined;
  return source ? { ...source, blurhash } : null;
}

export function getMusicArtwork({
  api,
  item,
  box,
}: {
  api?: Api | null;
  item: BaseItemDto;
  box: { width: number; height: number };
}): ImageSource | null {
  const albumId = item.AlbumId || item.ParentId;
  const hasAlbumArt =
    item.Type === "Audio" && albumId && item.AlbumPrimaryImageTag;
  const id = hasAlbumArt ? albumId : item.Id;
  const tag = hasAlbumArt ? item.AlbumPrimaryImageTag : item.ImageTags?.Primary;
  const step = CARD_IMAGE_HEIGHT_STEP_PX;
  const source = getArtworkByOwner({
    api,
    id,
    type: "Primary",
    tag,
    pixels: {
      width: Math.ceil(toImagePixels(box.width) / step) * step,
      height: Math.ceil(toImagePixels(box.height) / step) * step,
    },
  });
  const blurhash =
    !hasAlbumArt && tag
      ? (item.ImageBlurHashes?.Primary?.[tag] ?? undefined)
      : undefined;
  return source ? { ...source, blurhash } : null;
}

export function getArtworkForPixelBudget({
  api,
  item,
  purpose,
  pixels,
  preferEpisodeImage = false,
}: {
  api?: Api | null;
  item: BaseItemDto;
  purpose: ArtworkPurpose;
  pixels: { width: number; height: number };
  preferEpisodeImage?: boolean;
}): ImageSource | null {
  const density = PixelRatio.get();
  return getArtwork({
    api,
    item,
    purpose,
    box: {
      width: pixels.width / density,
      height: pixels.height / density,
    },
    maxWidthPx: pixels.width,
    preferEpisodeImage,
  });
}

export function getArtwork({
  api,
  item,
  purpose,
  box,
  focusScale = 1,
  preferEpisodeImage = false,
  portraitCover = false,
  maxWidthPx,
}: {
  api?: Api | null;
  item: BaseItemDto;
  purpose: ArtworkPurpose;
  box: { width: number; height: number };
  focusScale?: number;
  preferEpisodeImage?: boolean;
  portraitCover?: boolean;
  maxWidthPx?: number;
}): ImageSource | null {
  if (!api || box.width <= 0 || box.height <= 0) return null;

  let art: SelectedArt | null = null;
  if (purpose === "logo") {
    if (
      item.Type === "Episode" &&
      item.ParentLogoItemId &&
      item.ParentLogoImageTag
    ) {
      art = {
        id: item.ParentLogoItemId,
        type: "Logo",
        tag: item.ParentLogoImageTag,
      };
    } else if (item.Id && item.ImageTags?.Logo) {
      art = { id: item.Id, type: "Logo", tag: item.ImageTags.Logo };
    }
  } else if (purpose === "portrait") {
    if (
      item.Type === "Episode" &&
      item.SeriesId &&
      item.SeriesPrimaryImageTag
    ) {
      art = {
        id: item.SeriesId,
        type: "Primary",
        tag: item.SeriesPrimaryImageTag,
      };
    } else if (
      item.Type === "Episode" &&
      item.SeasonId &&
      item.ParentPrimaryImageTag
    ) {
      art = {
        id: item.SeasonId,
        type: "Primary",
        tag: item.ParentPrimaryImageTag,
      };
    } else if (item.Id && item.ImageTags?.Primary) {
      art = { id: item.Id, type: "Primary", tag: item.ImageTags.Primary };
    }
  } else if (purpose === "backdrop") {
    if (
      item.Type === "Episode" &&
      item.ParentBackdropItemId &&
      item.ParentBackdropImageTags?.[0]
    ) {
      art = {
        id: item.ParentBackdropItemId,
        type: "Backdrop",
        tag: item.ParentBackdropImageTags[0],
      };
    } else if (item.Id && item.BackdropImageTags?.[0]) {
      art = { id: item.Id, type: "Backdrop", tag: item.BackdropImageTags[0] };
    } else if (item.Id && item.ImageTags?.Primary) {
      art = { id: item.Id, type: "Primary", tag: item.ImageTags.Primary };
    }
  } else if (
    item.Type === "Episode" &&
    preferEpisodeImage &&
    item.Id &&
    item.ImageTags?.Primary
  ) {
    art = { id: item.Id, type: "Primary", tag: item.ImageTags.Primary };
  } else if (
    item.Type === "Episode" &&
    item.ParentThumbItemId &&
    item.ParentThumbImageTag
  ) {
    art = {
      id: item.ParentThumbItemId,
      type: "Thumb",
      tag: item.ParentThumbImageTag,
    };
  } else if (item.Id && item.ImageTags?.Thumb) {
    art = { id: item.Id, type: "Thumb", tag: item.ImageTags.Thumb };
  } else if (
    item.Type === "Episode" &&
    item.ParentBackdropItemId &&
    item.ParentBackdropImageTags?.[0]
  ) {
    art = {
      id: item.ParentBackdropItemId,
      type: "Backdrop",
      tag: item.ParentBackdropImageTags[0],
    };
  } else if (item.Id && item.BackdropImageTags?.[0]) {
    art = { id: item.Id, type: "Backdrop", tag: item.BackdropImageTags[0] };
  } else if (item.Id && item.ImageTags?.Primary) {
    art = { id: item.Id, type: "Primary", tag: item.ImageTags.Primary };
  }

  if (!art) return null;

  /**
   * Pixel width to request artwork at for a card this many layout points wide:
   * what the screen draws, rounded up to the next step so cards of nearly the
   * same width share one image.
   */
  const pixelWidth = toImagePixels(box.width * focusScale);
  const pixelHeight = toImagePixels(box.height * focusScale);
  const step =
    purpose === "backdrop"
      ? FULLSCREEN_IMAGE_STEP_PX
      : CARD_IMAGE_WIDTH_STEP_PX;
  const budgetScale =
    purpose === "backdrop"
      ? Math.min(
          1,
          Math.sqrt(MAX_FULLSCREEN_IMAGE_PIXELS / (pixelWidth * pixelHeight)),
        )
      : purpose === "logo"
        ? Math.min(1, MAX_LOGO_HEIGHT_PX / pixelHeight)
        : 1;
  const bucket = budgetScale < 1 ? Math.floor : Math.ceil;
  const requestedWidth = bucket((pixelWidth * budgetScale) / step) * step;
  const width = Math.min(requestedWidth, maxWidthPx ?? Infinity);
  const heightStep =
    purpose === "backdrop"
      ? FULLSCREEN_IMAGE_STEP_PX
      : CARD_IMAGE_HEIGHT_STEP_PX;
  const height =
    bucket((pixelHeight * budgetScale * width) / requestedWidth / heightStep) *
    heightStep;
  const source = getArtworkByOwner({
    api,
    id: art.id,
    type: art.type,
    tag: art.tag,
    pixels: {
      width,
      height: purpose === "portrait" && !portraitCover ? undefined : height,
    },
    fit: purpose === "logo",
    quality: purpose === "logo" ? 90 : 80,
  });
  const blurhash =
    art.id === item.Id
      ? (item.ImageBlurHashes?.[art.type]?.[art.tag] ?? undefined)
      : undefined;
  return source ? { ...source, blurhash } : null;
}
