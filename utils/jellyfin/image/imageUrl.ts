import type { Api } from "@jellyfin/sdk";
import type { ImageType } from "@jellyfin/sdk/lib/generated-client/models";
import { IMAGE_QUALITY } from "@/constants/Images";

/**
 * Identify one concrete image on the server: the owning `itemId`, the
 * `imageType`, and the `tag` that verifies the request. Omit `tag` only for
 * a speculative request — the server returns the type's default image or
 * 404s. `index` selects among several images of one type.
 */
export type Artwork = {
  itemId: string;
  imageType: ImageType;
  tag?: string | null;
  index?: number;
};

/**
 * Size the request in physical pixels — `toImagePixels` converts layout
 * points. `fillWidthPx` and `fillHeightPx` cover the box; `max*Px` caps
 * what that can cost. `widthPx` alone scales proportionally.
 */
export type ImageBox = {
  fillWidthPx?: number;
  fillHeightPx?: number;
  maxWidthPx?: number;
  maxHeightPx?: number;
  widthPx?: number;
  quality?: number;
};

/**
 * Build the `/Items/{id}/Images/{type}` URL — param names, order, tag and
 * quality all live here. Callers work in layout points through the facades;
 * call `imageUrl` directly only when the pixels are already known — a fixed
 * artwork budget, or a request a spec dictates.
 *
 * With no size at all the request gets `fillWidth=400`, the family's long
 * standing default.
 */
export const imageUrl = (
  api: Api | null | undefined,
  { itemId, imageType, tag, index }: Artwork,
  box: ImageBox = {},
): string | null => {
  if (!api) return null;

  const {
    fillWidthPx,
    fillHeightPx,
    maxWidthPx,
    maxHeightPx,
    widthPx,
    quality = IMAGE_QUALITY,
  } = box;

  const params = new URLSearchParams();
  if (
    fillWidthPx ||
    (!fillHeightPx && !widthPx && !maxWidthPx && !maxHeightPx)
  ) {
    params.set("fillWidth", String(Math.round(fillWidthPx ?? 400)));
  }
  if (fillHeightPx) params.set("fillHeight", String(Math.round(fillHeightPx)));
  if (maxWidthPx) params.set("maxWidth", String(Math.round(maxWidthPx)));
  if (maxHeightPx) params.set("maxHeight", String(Math.round(maxHeightPx)));
  if (widthPx) params.set("width", String(Math.round(widthPx)));
  params.set("quality", String(quality));
  if (tag) params.set("tag", tag);

  const path = `/Items/${itemId}/Images/${imageType}${index != null ? `/${index}` : ""}`;
  return `${api.basePath}${path}?${params.toString()}`;
};
