import {
  type BaseItemDto,
  ImageType,
} from "@jellyfin/sdk/lib/generated-client/models";
import { resolveArtwork } from "./resolveArtwork";

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

describe("resolveArtwork", () => {
  describe("tvCardLandscape", () => {
    test("an episode shows its series' thumb", () => {
      expect(resolveArtwork(episode, "tvCardLandscape")).toEqual({
        itemId: "series-1",
        imageType: ImageType.Thumb,
        tag: "series-thumb-tag",
      });
    });

    test("preferEpisodeImage shows the episode's own still first", () => {
      expect(
        resolveArtwork(episode, "tvCardLandscape", {
          preferEpisodeImage: true,
        }),
      ).toEqual({
        itemId: "episode-1",
        imageType: ImageType.Primary,
        tag: "still-tag",
      });
    });

    test("an episode without a series thumb falls back to the series backdrop", () => {
      expect(
        resolveArtwork(
          {
            ...episode,
            ParentThumbItemId: undefined,
            ParentThumbImageTag: undefined,
          },
          "tvCardLandscape",
        ),
      ).toEqual({
        itemId: "series-1",
        imageType: ImageType.Backdrop,
        tag: "series-backdrop-tag",
      });
    });

    test("an episode with neither falls back to its own still", () => {
      expect(
        resolveArtwork(
          {
            ...episode,
            ParentThumbItemId: undefined,
            ParentThumbImageTag: undefined,
            ParentBackdropImageTags: [],
          },
          "tvCardLandscape",
        ),
      ).toEqual({
        itemId: "episode-1",
        imageType: ImageType.Primary,
        tag: "still-tag",
      });
    });

    test("an episode carrying no artwork fields asks for the series thumb tagless", () => {
      expect(
        resolveArtwork(
          {
            ...episode,
            ImageTags: {},
            ParentThumbItemId: undefined,
            ParentThumbImageTag: undefined,
            ParentBackdropItemId: undefined,
            ParentBackdropImageTags: undefined,
          },
          "tvCardLandscape",
        ),
      ).toEqual({ itemId: "series-1", imageType: ImageType.Thumb });
    });

    test("a movie prefers its thumb, then its primary image", () => {
      expect(resolveArtwork(movie, "tvCardLandscape")).toEqual({
        itemId: "movie-1",
        imageType: ImageType.Thumb,
        tag: "thumb-tag",
      });
      expect(
        resolveArtwork(
          { ...movie, ImageTags: { Primary: "poster-tag" } },
          "tvCardLandscape",
        ),
      ).toEqual({
        itemId: "movie-1",
        imageType: ImageType.Primary,
        tag: "poster-tag",
      });
    });
  });

  describe("wideCard", () => {
    test("an episode shows its series' thumb, then its own primary", () => {
      expect(resolveArtwork(episode, "wideCard")).toEqual({
        itemId: "series-1",
        imageType: ImageType.Thumb,
        tag: "series-thumb-tag",
      });
      expect(
        resolveArtwork(
          {
            ...episode,
            ParentThumbItemId: undefined,
            ParentThumbImageTag: undefined,
          },
          "wideCard",
        ),
      ).toEqual({
        itemId: "episode-1",
        imageType: ImageType.Primary,
        tag: "still-tag",
      });
    });

    test("preferEpisodeImage skips the series thumb entirely", () => {
      expect(
        resolveArtwork(episode, "wideCard", { preferEpisodeImage: true }),
      ).toEqual({
        itemId: "episode-1",
        imageType: ImageType.Primary,
        tag: "still-tag",
      });
    });

    test("a movie prefers its thumb", () => {
      expect(resolveArtwork(movie, "wideCard")).toEqual({
        itemId: "movie-1",
        imageType: ImageType.Thumb,
        tag: "thumb-tag",
      });
    });
  });

  describe("portraitCard", () => {
    test("an episode shows its series' poster", () => {
      expect(resolveArtwork(episode, "portraitCard")).toEqual({
        itemId: "series-1",
        imageType: ImageType.Primary,
        tag: "series-poster-tag",
      });
    });

    // Never send a request the server can't fulfil: an untagged series
    // poster 404s, so the card falls back to the episode's own primary.
    test("an untagged series poster falls back to the episode's own primary", () => {
      expect(
        resolveArtwork(
          { ...episode, SeriesPrimaryImageTag: undefined },
          "portraitCard",
        ),
      ).toEqual({
        itemId: "episode-1",
        imageType: ImageType.Primary,
        tag: "still-tag",
      });
    });

    test("a movie shows its own primary image", () => {
      expect(resolveArtwork(movie, "portraitCard")).toEqual({
        itemId: "movie-1",
        imageType: ImageType.Primary,
        tag: "poster-tag",
      });
    });
  });

  describe("discoveryLandscape — nothing speculative leaves the tile", () => {
    test("an episode without a series thumb resolves to null, not a tagless request", () => {
      expect(
        resolveArtwork(
          {
            ...episode,
            ParentThumbItemId: undefined,
            ParentThumbImageTag: undefined,
          },
          "discoveryLandscape",
        ),
      ).toBeNull();
    });

    test("preferEpisodeImage accepts only a tagged still", () => {
      expect(
        resolveArtwork({ ...episode, ImageTags: {} }, "discoveryLandscape", {
          preferEpisodeImage: true,
        }),
      ).toBeNull();
      expect(
        resolveArtwork(episode, "discoveryLandscape", {
          preferEpisodeImage: true,
        }),
      ).toEqual({
        itemId: "episode-1",
        imageType: ImageType.Primary,
        tag: "still-tag",
      });
    });
  });

  describe("discoveryPoster", () => {
    test("an episode prefers its season's poster, then the series'", () => {
      const withSeason = {
        ...episode,
        SeasonId: "season-1",
        ParentPrimaryImageTag: "season-poster-tag",
      } satisfies BaseItemDto;
      expect(resolveArtwork(withSeason, "discoveryPoster")).toEqual({
        itemId: "season-1",
        imageType: ImageType.Primary,
        tag: "season-poster-tag",
      });
      expect(resolveArtwork(episode, "discoveryPoster")).toEqual({
        itemId: "series-1",
        imageType: ImageType.Primary,
        tag: "series-poster-tag",
      });
    });

    test("preferEpisodeImage goes straight to the still", () => {
      expect(
        resolveArtwork(episode, "discoveryPoster", {
          preferEpisodeImage: true,
        }),
      ).toEqual({
        itemId: "episode-1",
        imageType: ImageType.Primary,
        tag: "still-tag",
      });
    });
  });

  test("returns null for no item", () => {
    expect(resolveArtwork(null, "portraitCard")).toBeNull();
  });
});
