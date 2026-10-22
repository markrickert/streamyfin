import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client/models";
import { PixelRatio } from "react-native";
import { makeApi } from "@/test-utils/jellyfinApi";
import {
  getTVEpisodeArtworkUrl,
  getTVPosterImageUrl,
} from "./getTVPosterImageUrl";

const api = makeApi();

const onScreenDensity = (density: number) =>
  jest.spyOn(PixelRatio, "get").mockReturnValue(density);

afterEach(() => {
  jest.restoreAllMocks();
});

const movie = {
  Id: "movie-1",
  Type: "Movie",
  ImageTags: { Primary: "poster-tag", Thumb: "thumb-tag" },
  BackdropImageTags: [],
} satisfies BaseItemDto;

const episode = {
  Id: "episode-1",
  Type: "Episode",
  SeriesId: "series-1",
  SeriesPrimaryImageTag: "series-poster-tag",
  ImageTags: { Primary: "still-tag" },
  ParentThumbItemId: "series-1",
  ParentThumbImageTag: "series-thumb-tag",
  ParentBackdropItemId: "series-1",
  ParentBackdropImageTags: ["series-backdrop-tag"],
} satisfies BaseItemDto;

const sizeOf = (url: string | null) => {
  const params = new URL(url ?? "").searchParams;
  return {
    fillWidth: params.get("fillWidth"),
    fillHeight: params.get("fillHeight"),
  };
};

// The default text scale on a 1920 point wide TV draws a portrait poster
// 189 points wide and a landscape card 277.
const PORTRAIT_WIDTH = 189;
const LANDSCAPE_WIDTH = 277;

describe("getTVPosterImageUrl", () => {
  describe("asks for the size the card is drawn at", () => {
    test("a portrait poster on a 1x screen", () => {
      onScreenDensity(1);

      const url = getTVPosterImageUrl({
        api,
        item: movie,
        orientation: "vertical",
        widthPoints: PORTRAIT_WIDTH,
      });

      expect(url).toBe(
        `${api.basePath}/Items/movie-1/Images/Primary?fillWidth=200&quality=80&tag=poster-tag`,
      );
    });

    test("a portrait poster on a 2x screen", () => {
      onScreenDensity(2);

      const url = getTVPosterImageUrl({
        api,
        item: movie,
        orientation: "vertical",
        widthPoints: PORTRAIT_WIDTH,
      });

      expect(sizeOf(url)).toEqual({ fillWidth: "400", fillHeight: null });
    });

    test("a landscape card on a 1x screen", () => {
      onScreenDensity(1);

      const url = getTVPosterImageUrl({
        api,
        item: movie,
        orientation: "horizontal",
        widthPoints: LANDSCAPE_WIDTH,
      });

      expect(url).toBe(
        `${api.basePath}/Items/movie-1/Images/Thumb?fillWidth=300&fillHeight=169&quality=80&tag=thumb-tag`,
      );
    });

    test("a landscape card on a 2x screen", () => {
      onScreenDensity(2);

      const url = getTVPosterImageUrl({
        api,
        item: movie,
        orientation: "horizontal",
        widthPoints: LANDSCAPE_WIDTH,
      });

      expect(sizeOf(url)).toEqual({ fillWidth: "600", fillHeight: "338" });
    });

    test("never past the card artwork cap, however wide the card", () => {
      onScreenDensity(2);

      const url = getTVPosterImageUrl({
        api,
        item: movie,
        orientation: "horizontal",
        widthPoints: 600,
      });

      expect(sizeOf(url)).toEqual({ fillWidth: "800", fillHeight: "450" });
    });
  });

  describe("picks artwork in fallback order", () => {
    beforeEach(() => {
      onScreenDensity(1);
    });

    test("an episode shows its series' thumb", () => {
      const url = getTVPosterImageUrl({
        api,
        item: episode,
        orientation: "horizontal",
        widthPoints: LANDSCAPE_WIDTH,
      });

      expect(url).toBe(
        `${api.basePath}/Items/series-1/Images/Thumb?fillWidth=300&fillHeight=169&quality=80&tag=series-thumb-tag`,
      );
    });

    test("an episode shows its own still with the episode image preference", () => {
      const url = getTVPosterImageUrl({
        api,
        item: episode,
        orientation: "horizontal",
        widthPoints: LANDSCAPE_WIDTH,
        preferEpisodeImage: true,
      });

      expect(url).toBe(
        `${api.basePath}/Items/episode-1/Images/Primary?fillWidth=300&fillHeight=169&quality=80&tag=still-tag`,
      );
    });

    test("an episode without a series thumb falls back to the series backdrop", () => {
      const url = getTVPosterImageUrl({
        api,
        item: {
          ...episode,
          ParentThumbItemId: undefined,
          ParentThumbImageTag: undefined,
        },
        orientation: "horizontal",
        widthPoints: LANDSCAPE_WIDTH,
      });

      expect(url).toBe(
        `${api.basePath}/Items/series-1/Images/Backdrop?fillWidth=300&fillHeight=169&quality=80&tag=series-backdrop-tag`,
      );
    });

    test("an episode with neither falls back to its own still", () => {
      const url = getTVPosterImageUrl({
        api,
        item: {
          ...episode,
          ParentThumbItemId: undefined,
          ParentThumbImageTag: undefined,
          ParentBackdropImageTags: [],
        },
        orientation: "horizontal",
        widthPoints: LANDSCAPE_WIDTH,
      });

      expect(url).toBe(
        `${api.basePath}/Items/episode-1/Images/Primary?fillWidth=300&fillHeight=169&quality=80&tag=still-tag`,
      );
    });

    test("a landscape card without a thumb shows the primary image", () => {
      const url = getTVPosterImageUrl({
        api,
        item: { ...movie, ImageTags: { Primary: "poster-tag" } },
        orientation: "horizontal",
        widthPoints: LANDSCAPE_WIDTH,
      });

      expect(url).toBe(
        `${api.basePath}/Items/movie-1/Images/Primary?fillWidth=300&fillHeight=169&quality=80&tag=poster-tag`,
      );
    });

    test("an episode carrying no artwork fields at all asks for the series thumb tagless", () => {
      const url = getTVPosterImageUrl({
        api,
        item: {
          ...episode,
          ImageTags: {},
          ParentThumbItemId: undefined,
          ParentThumbImageTag: undefined,
          ParentBackdropItemId: undefined,
          ParentBackdropImageTags: undefined,
        },
        orientation: "horizontal",
        widthPoints: LANDSCAPE_WIDTH,
      });

      // The episode's own Primary 404s when it has no tag; the series' thumb
      // is what every other Jellyfin client shows here.
      expect(url).toBe(
        `${api.basePath}/Items/series-1/Images/Thumb?fillWidth=300&fillHeight=169&quality=80`,
      );
    });

    test("a portrait episode shows its series' poster", () => {
      const url = getTVPosterImageUrl({
        api,
        item: episode,
        orientation: "vertical",
        widthPoints: PORTRAIT_WIDTH,
      });

      expect(url).toBe(
        `${api.basePath}/Items/series-1/Images/Primary?fillWidth=200&quality=80&tag=series-poster-tag`,
      );
    });
  });

  // The detail page draws the series artwork at its own size, not a card's,
  // and must still ask for the tagged series thumb the cards ask for.
  test("the episode artwork at an exact pixel width", () => {
    const url = getTVEpisodeArtworkUrl({ api, item: episode, widthPx: 672 });

    expect(url).toBe(
      `${api.basePath}/Items/series-1/Images/Thumb?fillWidth=672&fillHeight=378&quality=80&tag=series-thumb-tag`,
    );
  });

  test("returns null without an api", () => {
    expect(
      getTVPosterImageUrl({
        api: null,
        item: movie,
        orientation: "vertical",
        widthPoints: PORTRAIT_WIDTH,
      }),
    ).toBeNull();
  });
});
