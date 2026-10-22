import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client/models";
import { PixelRatio } from "react-native";
import { makeApi } from "@/test-utils/jellyfinApi";
import { stubReactNative } from "@/test-utils/reactNative";
import { getBackdropUrl } from "./getBackdropUrl";
import { getParentBackdropImageUrl } from "./getParentBackdropImageUrl";

stubReactNative();

const api = makeApi();

const movie = {
  Id: "movie-1",
  Type: "Movie",
  BackdropImageTags: ["backdrop-tag"],
} satisfies BaseItemDto;

const onScreenDensity = (density: number) =>
  jest.spyOn(PixelRatio, "get").mockReturnValue(density);

afterEach(() => {
  jest.restoreAllMocks();
});

const sizeOf = (url: string | null) => {
  const params = new URL(url ?? "").searchParams;
  return {
    fillWidth: params.get("fillWidth"),
    fillHeight: params.get("fillHeight"),
    maxWidth: params.get("maxWidth"),
    maxHeight: params.get("maxHeight"),
  };
};

describe("getBackdropUrl", () => {
  // Issue #2166: a 16:9 backdrop covering a header taller than 16:9 is bound
  // by its height. Asked for by width alone it came back a third as tall as
  // the header and was scaled up to cover it.
  test("asks for an image that covers the whole box when given its height", () => {
    onScreenDensity(1);
    const url = getBackdropUrl({
      api,
      item: movie,
      widthPoints: 1233,
      heightPoints: 1500,
    });

    expect(url).toContain("/Items/movie-1/Images/Backdrop/0?");
    expect(sizeOf(url)).toEqual({
      fillWidth: "1233",
      fillHeight: "1500",
      maxWidth: "1920",
      maxHeight: "1920",
    });
  });

  test("scales the drawn size by the screen density", () => {
    onScreenDensity(2);
    const url = getBackdropUrl({
      api,
      item: movie,
      widthPoints: 960,
      heightPoints: 540,
    });

    expect(sizeOf(url)).toEqual({
      fillWidth: "1920",
      fillHeight: "1080",
      maxWidth: "1920",
      maxHeight: "1920",
    });
  });

  test("leaves a width only request as it was", () => {
    onScreenDensity(1);
    const url = getBackdropUrl({
      api,
      item: movie,
      quality: 90,
      widthPoints: 1920,
    });

    expect(url).toBe(
      `${api.basePath}/Items/movie-1/Images/Backdrop/0?fillWidth=1920&quality=90&tag=backdrop-tag`,
    );
  });

  test("covers the box with the primary image when there is no backdrop", () => {
    onScreenDensity(1);
    const url = getBackdropUrl({
      api,
      item: {
        Id: "episode-1",
        Type: "Episode",
        ImageTags: { Primary: "p" },
        BackdropImageTags: [],
      },
      widthPoints: 1017,
      heightPoints: 1170,
    });

    expect(url).toContain("/Items/episode-1/Images/Primary?");
    expect(sizeOf(url)).toEqual({
      fillWidth: "1017",
      fillHeight: "1170",
      maxWidth: "1920",
      maxHeight: "1920",
    });
  });
});

describe("getParentBackdropImageUrl", () => {
  const episode = {
    Id: "episode-1",
    Type: "Episode",
    ParentBackdropItemId: "series-1",
    ParentBackdropImageTags: ["series-backdrop-tag"],
  } satisfies BaseItemDto;

  test("asks for an image that covers the whole box when given its height", () => {
    onScreenDensity(1);
    const url = getParentBackdropImageUrl({
      api,
      item: episode,
      widthPoints: 1017,
      heightPoints: 1170,
    });

    expect(url).toContain("/Items/series-1/Images/Backdrop/0?");
    expect(sizeOf(url)).toEqual({
      fillWidth: "1017",
      fillHeight: "1170",
      maxWidth: "1920",
      maxHeight: "1920",
    });
  });

  test("leaves a width only request as it was", () => {
    onScreenDensity(1);
    expect(
      getParentBackdropImageUrl({
        api,
        item: episode,
        quality: 80,
        widthPoints: 678,
      }),
    ).toBe(
      `${api.basePath}/Items/series-1/Images/Backdrop/0?fillWidth=678&quality=80&tag=series-backdrop-tag`,
    );
  });
});
