import { ImageType } from "@jellyfin/sdk/lib/generated-client/models";

import { IMAGE_QUALITY } from "@/constants/Images";
import { makeApi } from "@/test-utils/jellyfinApi";
import { imageUrl } from "./imageUrl";

const api = makeApi();

const poster = { itemId: "movie-1", imageType: ImageType.Primary, tag: "t1" };

describe("imageUrl", () => {
  test("builds a fill-box request in canonical param order", () => {
    expect(imageUrl(api, poster, { fillWidthPx: 300, fillHeightPx: 169 })).toBe(
      `${api.basePath}/Items/movie-1/Images/Primary?fillWidth=300&fillHeight=169&quality=80&tag=t1`,
    );
  });

  test("carries the image index in the path", () => {
    expect(
      imageUrl(
        api,
        { itemId: "s1", imageType: ImageType.Backdrop, tag: "b1", index: 0 },
        { fillWidthPx: 1920 },
      ),
    ).toBe(
      `${api.basePath}/Items/s1/Images/Backdrop/0?fillWidth=1920&quality=80&tag=b1`,
    );
  });

  test("a tagless artwork asks the server for its default image", () => {
    expect(
      imageUrl(api, { itemId: "s1", imageType: ImageType.Thumb }, {}),
    ).toBe(
      `${api.basePath}/Items/s1/Images/Thumb?fillWidth=400&quality=${IMAGE_QUALITY}`,
    );
  });

  test("falls back to the family's default width when no size is given", () => {
    expect(imageUrl(api, poster, {})).toBe(
      `${api.basePath}/Items/movie-1/Images/Primary?fillWidth=400&quality=80&tag=t1`,
    );
  });

  test("a fillHeight-only request does not invent a width", () => {
    expect(imageUrl(api, poster, { fillHeightPx: 1080 })).toBe(
      `${api.basePath}/Items/movie-1/Images/Primary?fillHeight=1080&quality=80&tag=t1`,
    );
  });

  test("supports the proportional-width and max-bound params", () => {
    expect(
      imageUrl(api, poster, { widthPx: 500, maxWidthPx: 1920, quality: 90 }),
    ).toBe(
      `${api.basePath}/Items/movie-1/Images/Primary?maxWidth=1920&width=500&quality=90&tag=t1`,
    );
  });

  test("returns null without an api", () => {
    expect(imageUrl(null, poster, {})).toBeNull();
  });
});
