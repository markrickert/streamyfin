import { render, screen } from "@testing-library/react-native";
import { PixelRatio } from "react-native";
import { TVPosterCard } from "./TVPosterCard";

jest.mock("@/providers/JellyfinProvider", () =>
  jest
    .requireActual("@/test-utils/jellyfinProvider")
    .makeJellyfinAtomsModule({ basePath: "https://jellyfin.example.com" }),
);
jest.mock("@/utils/customHeaders", () =>
  jest.requireActual("@/test-utils/customHeaders").customHeadersModule(),
);
// The global double names an image after its URL; these specs read the
// source of the one artwork element.
jest.mock("@/components/common/ServerImage", () => ({
  Image: (props: Record<string, unknown>) =>
    jest
      .requireActual("react")
      .createElement(jest.requireActual("react-native").Image, {
        ...props,
        testID: "artwork",
      }),
}));
jest.mock("@/components/WatchedIndicator", () => ({
  UnplayedCountBadge: () => null,
  WatchedIndicator: () => null,
}));
jest.mock("@/modules/glass-poster", () => ({
  GlassPosterView: () => null,
  isGlassEffectAvailable: () => false,
}));
jest.mock("@/constants/TVPosterSizes", () => ({
  useScaledTVPosterSizes: () => ({ poster: 200, episode: 300 }),
}));
jest.mock("@/constants/TVTypography", () => ({
  useScaledTVTypography: () => ({ callout: 20, body: 20, heading: 30 }),
}));

afterEach(() => jest.restoreAllMocks());

test("a focused 1080p wide card requests the pixels its displayed box covers", async () => {
  jest
    .spyOn(PixelRatio, "getPixelSizeForLayoutSize")
    .mockImplementation((points) => Math.round(points * 2));

  await render(
    <TVPosterCard
      item={{
        Id: "movie-1",
        Name: "Movie",
        Type: "Movie",
        ImageTags: { Thumb: "thumb +/tag" },
      }}
      orientation='horizontal'
      width={300}
      onPress={() => {}}
    />,
  );

  const source = screen.getByTestId("artwork").props.source;
  const url = new URL(source.uri);
  expect(url.pathname).toBe("/Items/movie-1/Images/Thumb");
  expect(url.searchParams.get("tag")).toBe("thumb +/tag");
  expect(Number(url.searchParams.get("fillWidth"))).toBeGreaterThanOrEqual(630);
  expect(Number(url.searchParams.get("fillWidth"))).toBeLessThanOrEqual(730);
  expect(Number(url.searchParams.get("fillHeight"))).toBeGreaterThanOrEqual(
    355,
  );
  expect(Number(url.searchParams.get("fillHeight"))).toBeLessThanOrEqual(455);
});

test("an episode poster does not show its still's blurhash over series artwork", async () => {
  await render(
    <TVPosterCard
      item={{
        Id: "episode-1",
        Name: "Pilot",
        Type: "Episode",
        SeriesId: "series-1",
        SeriesPrimaryImageTag: "series-tag",
        ImageTags: { Primary: "still-tag" },
        ImageBlurHashes: {
          Primary: { "still-tag": "still-blurhash" },
        },
      }}
      onPress={() => {}}
    />,
  );

  const artwork = screen.getByTestId("artwork").props;
  expect(new URL(artwork.source.uri).pathname).toBe(
    "/Items/series-1/Images/Primary",
  );
  expect(artwork.placeholder?.blurhash).toBeUndefined();
});

// The badge on the episode a page is about read "Now Playing" in English
// whatever the language (seen in French on an Android TV, 2026-11-03).
test("the badge of the current item speaks the user's language", async () => {
  await render(
    <TVPosterCard
      item={{ Id: "e1", Name: "Pilot", Type: "Episode" }}
      orientation='horizontal'
      imageUrlGetter={() =>
        "https://jellyfin.example.com/Items/e1/Images/Primary"
      }
      isCurrent
      onPress={() => {}}
    />,
  );

  expect(screen.getByText("player.now_playing")).toBeTruthy();
  expect(screen.queryByText("Now Playing")).toBeNull();
});
