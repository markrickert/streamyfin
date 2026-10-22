import type { Api } from "@jellyfin/sdk";
import type {
  ImageFormat,
  ImageType,
} from "@jellyfin/sdk/lib/generated-client/models";
import { IMAGE_QUALITY, MAX_IMAGE_SIDE_PX } from "@/constants/Images";
import { toImagePixels } from "./imagePixels";

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
  format?: ImageFormat;
};

/**
 * Build the `/Items/{id}/Images/{type}` URL — param names, order, tag and
 * quality all live here. Callers work in layout points through the facades;
 * call `imageUrl` directly only when the pixels are already known — a fixed
 * artwork budget, or a request a spec dictates.
 *
 * With no size at all the request gets `fillWidth=400`, the family's long
 * standing default. A null `artwork` returns null, so the resolver and the
 * constructor compose in one expression.
 */
export const imageUrl = (
  api: Pick<Api, "basePath"> | null | undefined,
  artwork: Artwork | null,
  box: ImageBox = {},
): string | null => {
  if (!api || !artwork) return null;
  const { itemId, imageType, tag, index } = artwork;

  const {
    fillWidthPx,
    fillHeightPx,
    maxWidthPx,
    maxHeightPx,
    widthPx,
    quality = IMAGE_QUALITY,
    format,
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
  if (format) params.set("format", format);

  const path = `/Items/${itemId}/Images/${imageType}${index != null ? `/${index}` : ""}`;
  return `${api.basePath}${path}?${params.toString()}`;
};

/**
 * Cover the box: a fill request plus the hard caps that bound the cost. The
 * server applies the maximums first and never scales back up — a wide
 * backdrop asked by width alone returns too few rows and gets stretched to
 * cover.
 */
export const coverBox = (
  box: Pick<ImageBox, "fillWidthPx" | "fillHeightPx">,
): ImageBox => ({
  ...box,
  maxWidthPx: MAX_IMAGE_SIDE_PX,
  maxHeightPx: MAX_IMAGE_SIDE_PX,
});

/** The 16:9 fill box landscape cards and episode stills are drawn in. */
export const landscapeBox = (widthPx: number): ImageBox => ({
  fillWidthPx: widthPx,
  fillHeightPx: Math.round((widthPx * 9) / 16),
});

/**
 * Convert the drawn box from layout points to the pixels the server sizes
 * in — the shape every caller-facing helper takes. With a height the
 * request covers the box (see `coverBox`); width alone is a plain fill.
 */
export const pointsBox = ({
  widthPoints,
  heightPoints,
}: {
  widthPoints?: number | null;
  heightPoints?: number | null;
}): ImageBox =>
  heightPoints != null
    ? coverBox({
        fillWidthPx:
          widthPoints != null ? toImagePixels(widthPoints) : undefined,
        fillHeightPx: toImagePixels(heightPoints),
      })
    : {
        fillWidthPx:
          widthPoints != null ? toImagePixels(widthPoints) : undefined,
      };
