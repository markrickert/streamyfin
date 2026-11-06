import { render, screen } from "@testing-library/react-native";
import { PixelRatio } from "react-native";
import { TVHeroCarousel } from "./TVHeroCarousel";

jest.mock("@/utils/customHeaders", () =>
  jest.requireActual("@/test-utils/customHeaders").customHeadersModule(),
);
jest.mock("@/providers/JellyfinProvider", () => ({
  apiAtom: jest
    .requireActual("jotai")
    .atom({ basePath: "https://jellyfin.example.com" }),
}));
jest.mock(
  "@/components/common/ServerImage",
  () => jest.requireActual("@/test-utils/serverImage").serverImageModule,
);
jest.mock("@/constants/TVSizes", () => ({
  useScaledTVSizes: () => ({
    posters: { episode: 200 },
    animation: { focusScale: 1.05 },
    padding: { heroHeight: 0.6, horizontal: 60 },
    gaps: { item: 24, small: 12 },
  }),
  TV_BACKDROP_DEBOUNCE_MS: 300,
}));
jest.mock("@/constants/TVTypography", () => ({
  useScaledTVTypography: () => ({ body: 20, callout: 20, display: 40 }),
}));
jest.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
jest.mock("@/hooks/useAppRouter", () => () => ({ push: () => {} }));
jest.mock("@/components/common/TouchableItemRouter", () => ({
  getItemNavigation: () => "/",
}));
jest.mock("@/modules/glass-poster", () => ({
  GlassPosterView: () => null,
  isGlassEffectAvailable: () => false,
}));
jest.mock("expo-linear-gradient", () => ({ LinearGradient: () => null }));
jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
jest.mock("@/components/common/ProgressBar", () => ({
  ProgressBar: () => null,
}));

afterEach(() => jest.restoreAllMocks());

test("the TV hero card shows its tagged parent backdrop at its focused draw size", async () => {
  jest.spyOn(PixelRatio, "get").mockReturnValue(2);

  await render(
    <TVHeroCarousel
      items={[
        {
          Id: "episode-1",
          Name: "Pilot",
          Type: "Episode",
          ImageTags: { Primary: "still" },
          ParentBackdropItemId: "series-1",
          ParentBackdropImageTags: ["series-backdrop"],
        },
      ]}
    />,
  );

  const image = screen.getAllByTestId(/^image /).at(-1)!;
  const url = new URL(image.props.source.uri);
  expect(url.pathname).toBe("/Items/series-1/Images/Backdrop");
  expect(url.searchParams.get("tag")).toBe("series-backdrop");
  expect(Number(url.searchParams.get("fillWidth"))).toBeGreaterThanOrEqual(420);
  expect(Number(url.searchParams.get("fillHeight"))).toBeGreaterThanOrEqual(
    236,
  );
  expect(Number(url.searchParams.get("fillHeight"))).toBeLessThan(350);
});

test("the TV hero logo is fitted to its visible slot without cropping", async () => {
  await render(
    <TVHeroCarousel
      items={[
        {
          Id: "movie-1",
          Name: "Movie",
          Type: "Movie",
          ImageTags: { Primary: "poster", Logo: "logo-tag" },
        },
      ]}
    />,
  );

  const image = screen
    .getAllByTestId(/^image /)
    .find((node) => node.props.source.uri.includes("/Images/Logo"));
  const url = new URL(image!.props.source.uri);
  expect(url.searchParams.get("tag")).toBe("logo-tag");
  expect(url.searchParams.has("fillHeight")).toBe(false);
  expect(url.searchParams.has("maxHeight")).toBe(true);
});
