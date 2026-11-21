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
  FULLSCREEN_IMAGE_QUALITY,
  FULLSCREEN_IMAGE_STEP_PX,
  IMAGE_QUALITY,
  MAX_FULLSCREEN_IMAGE_PIXELS,
  MAX_LOGO_HEIGHT_PX,
} from "@/constants/Images";
import { getJellyfinHeadersForUrl } from "@/utils/customHeaders";
import { toImagePixels } from "./imagePixels";
import { itemImageUrl } from "./itemImageUrl";

type ArtworkPurpose = "portrait" | "wide" | "backdrop" | "logo";
type SelectedImage = {
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
  quality = IMAGE_QUALITY,
}: {
  api?: Api | null;
  id?: string | null;
  type: SelectedImage["type"];
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

const imageWithTag = (
  id: string | null | undefined,
  type: SelectedImage["type"],
  tag: string | null | undefined,
): SelectedImage | null => (id && tag ? { id, type, tag } : null);

/** First candidate that has both an owner id and an image tag wins. */
function selectImage(
  item: BaseItemDto,
  purpose: ArtworkPurpose,
  preferEpisodeImage: boolean,
): SelectedImage | null {
  const isEpisode = item.Type === "Episode";
  const episodeOnly = (image: SelectedImage | null) =>
    isEpisode ? image : null;

  const ownPrimary = imageWithTag(item.Id, "Primary", item.ImageTags?.Primary);
  const ownThumb = imageWithTag(item.Id, "Thumb", item.ImageTags?.Thumb);
  const ownBackdrop = imageWithTag(
    item.Id,
    "Backdrop",
    item.BackdropImageTags?.[0],
  );
  const parentBackdrop = episodeOnly(
    imageWithTag(
      item.ParentBackdropItemId,
      "Backdrop",
      item.ParentBackdropImageTags?.[0],
    ),
  );

  switch (purpose) {
    case "logo":
      return (
        episodeOnly(
          imageWithTag(item.ParentLogoItemId, "Logo", item.ParentLogoImageTag),
        ) ?? imageWithTag(item.Id, "Logo", item.ImageTags?.Logo)
      );
    case "portrait":
      return (
        episodeOnly(
          imageWithTag(item.SeriesId, "Primary", item.SeriesPrimaryImageTag),
        ) ??
        episodeOnly(
          imageWithTag(item.SeasonId, "Primary", item.ParentPrimaryImageTag),
        ) ??
        ownPrimary
      );
    case "backdrop":
      return parentBackdrop ?? ownBackdrop ?? ownPrimary;
    case "wide":
      return (
        (preferEpisodeImage ? episodeOnly(ownPrimary) : null) ??
        episodeOnly(
          imageWithTag(
            item.ParentThumbItemId,
            "Thumb",
            item.ParentThumbImageTag,
          ),
        ) ??
        ownThumb ??
        parentBackdrop ??
        ownBackdrop ??
        ownPrimary
      );
  }
}

type ImageSizingRule = {
  widthStep: number;
  heightStep: number;
  quality: number;
  /** Shrinks the request below the screen's pixels; 1 leaves it alone. */
  scaleToLimit: (pixels: { width: number; height: number }) => number;
};

const CARD_IMAGE_SIZING: ImageSizingRule = {
  widthStep: CARD_IMAGE_WIDTH_STEP_PX,
  heightStep: CARD_IMAGE_HEIGHT_STEP_PX,
  quality: IMAGE_QUALITY,
  scaleToLimit: () => 1,
};

const IMAGE_SIZING_BY_PURPOSE: Record<ArtworkPurpose, ImageSizingRule> = {
  portrait: CARD_IMAGE_SIZING,
  wide: CARD_IMAGE_SIZING,
  logo: {
    ...CARD_IMAGE_SIZING,
    quality: 90,
    scaleToLimit: ({ height }) => Math.min(1, MAX_LOGO_HEIGHT_PX / height),
  },
  backdrop: {
    widthStep: FULLSCREEN_IMAGE_STEP_PX,
    heightStep: FULLSCREEN_IMAGE_STEP_PX,
    quality: FULLSCREEN_IMAGE_QUALITY,
    scaleToLimit: ({ width, height }) =>
      Math.min(1, Math.sqrt(MAX_FULLSCREEN_IMAGE_PIXELS / (width * height))),
  },
};

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

  const selectedImage = selectImage(item, purpose, preferEpisodeImage);
  if (!selectedImage) return null;

  /**
   * Pixel size to request artwork at for a box this many layout points wide:
   * what the screen draws, rounded to a step so images of nearly the same
   * size share one URL.
   */
  const drawWidthPx = toImagePixels(box.width * focusScale);
  const drawHeightPx = toImagePixels(box.height * focusScale);
  const { widthStep, heightStep, quality, scaleToLimit } =
    IMAGE_SIZING_BY_PURPOSE[purpose];
  const sizeScale = scaleToLimit({ width: drawWidthPx, height: drawHeightPx });
  const roundToStep = sizeScale < 1 ? Math.floor : Math.ceil;
  const roundedWidthPx =
    roundToStep((drawWidthPx * sizeScale) / widthStep) * widthStep;
  const requestWidthPx = Math.min(roundedWidthPx, maxWidthPx ?? Infinity);
  const requestHeightPx =
    roundToStep(
      (drawHeightPx * sizeScale * requestWidthPx) / roundedWidthPx / heightStep,
    ) * heightStep;
  const source = getArtworkByOwner({
    api,
    id: selectedImage.id,
    type: selectedImage.type,
    tag: selectedImage.tag,
    pixels: {
      width: requestWidthPx,
      height:
        purpose === "portrait" && !portraitCover ? undefined : requestHeightPx,
    },
    fit: purpose === "logo",
    quality,
  });
  const blurhash =
    selectedImage.id === item.Id
      ? (item.ImageBlurHashes?.[selectedImage.type]?.[selectedImage.tag] ??
        undefined)
      : undefined;
  return source ? { ...source, blurhash } : null;
}
