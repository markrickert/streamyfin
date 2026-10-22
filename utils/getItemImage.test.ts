import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client/models";
import { makeApi } from "@/test-utils/jellyfinApi";
import { getItemImage } from "./getItemImage";

jest.mock("@/utils/customHeaders", () =>
  jest.requireActual("@/test-utils/customHeaders").customHeadersModule(),
);

const api = makeApi();

const movie = {
  Id: "movie-1",
  Type: "Movie",
  ImageTags: { Primary: "primary-tag" },
  BackdropImageTags: ["backdrop-tag"],
} satisfies BaseItemDto;

describe("getItemImage", () => {
  // Issue #2166: the detail page header asked for a 1000 pixel wide backdrop
  // and covered a 1233 by 1500 pixel box with it.
  test("asks for an image that covers the whole box when given its height", () => {
    const source = getItemImage({
      api,
      item: movie,
      variant: "Backdrop",
      widthPx: 1233,
      heightPx: 1500,
    });

    expect(source?.uri).toBe(
      `${api.basePath}/Items/movie-1/Images/Backdrop/0?fillWidth=1233&fillHeight=1500&maxWidth=1920&maxHeight=1920&quality=90&tag=backdrop-tag`,
    );
  });

  test("covers the box with the primary image too", () => {
    const source = getItemImage({
      api,
      item: movie,
      widthPx: 1233,
      heightPx: 1050,
    });

    expect(source?.uri).toBe(
      `${api.basePath}/Items/movie-1/Images/Primary?fillWidth=1233&fillHeight=1050&maxWidth=1920&maxHeight=1920&quality=90&tag=primary-tag`,
    );
  });

  test("leaves a width only request as it was", () => {
    const source = getItemImage({ api, item: movie, variant: "Backdrop" });

    expect(source?.uri).toBe(
      `${api.basePath}/Items/movie-1/Images/Backdrop/0?width=1000&quality=90&tag=backdrop-tag`,
    );
  });

  // A Thumb tag must never reach the Backdrop endpoint: it 404s on an item
  // that has a Thumb but no Backdrop.
  test("the Thumb variant requests the Thumb image", () => {
    const source = getItemImage({
      api,
      item: { Id: "movie-1", Type: "Movie", ImageTags: { Thumb: "thumb-tag" } },
      variant: "Thumb",
    });

    expect(source?.uri).toBe(
      `${api.basePath}/Items/movie-1/Images/Thumb?width=1000&quality=90&tag=thumb-tag`,
    );
  });
});
