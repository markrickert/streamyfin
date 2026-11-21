import { render, screen } from "@testing-library/react-native";
import { Dimensions, PixelRatio } from "react-native";
import { TV_DETAIL_POSTER_WIDTH_RATIO } from "@/constants/TVDetailLayout";
import { toImagePixels } from "@/utils/jellyfin/image/imagePixels";
import { ItemImage } from "./ItemImage";

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
jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));

afterEach(() => {
  jest.restoreAllMocks();
});

test("a full-screen image covers the current viewport without a 1920px cap", async () => {
  await render(
    <ItemImage
      item={{
        Id: "movie-1",
        Type: "Movie",
        BackdropImageTags: ["backdrop"],
      }}
      variant='Backdrop'
    />,
  );

  const image = screen.getByTestId(/^image /);
  const url = new URL(image.props.source);
  const { width, height } = Dimensions.get("window");
  expect(Number(url.searchParams.get("fillWidth"))).toBeGreaterThanOrEqual(
    width * PixelRatio.get(),
  );
  expect(Number(url.searchParams.get("fillHeight"))).toBeGreaterThanOrEqual(
    height * PixelRatio.get(),
  );
});

test("a full-screen image without artwork has a fallback instead of a broken URL", async () => {
  await render(
    <ItemImage item={{ Id: "movie-1", Type: "Movie" }} variant='Backdrop' />,
  );

  expect(screen.queryByTestId(/^image /)).toBeNull();
});

// An explicit pixel size, like the TV detail poster's, bounds the request
// to the poster's box instead of the whole window.
test("an explicit portrait size requests bounded fill, not the screen's pixels", async () => {
  jest.spyOn(PixelRatio, "get").mockReturnValue(2);
  const posterPoints = 1920 * TV_DETAIL_POSTER_WIDTH_RATIO;
  const posterWidthPx = toImagePixels(posterPoints);

  await render(
    <ItemImage
      item={{
        Id: "movie-1",
        Type: "Movie",
        ImageTags: { Primary: "poster" },
      }}
      variant='Primary'
      width={posterWidthPx}
      height={toImagePixels(posterPoints * 1.5)}
    />,
  );

  const image = screen.getByTestId(/^image /);
  const url = new URL(image.props.source);
  const fillWidth = Number(url.searchParams.get("fillWidth"));
  expect(fillWidth).toBeGreaterThanOrEqual(posterWidthPx);
  // The fallback requests the window's pixels; a bounded one stays below.
  expect(fillWidth).toBeLessThan(toImagePixels(Dimensions.get("window").width));
});

test("a general episode portrait uses its series poster with the series tag", async () => {
  await render(
    <ItemImage
      item={{
        Id: "episode-1",
        Type: "Episode",
        SeriesId: "series-1",
        SeriesPrimaryImageTag: "series-poster",
        ImageTags: { Primary: "episode-still" },
      }}
      variant='Primary'
      width={300}
      height={450}
    />,
  );

  const image = screen.getByTestId(/^image /);
  const url = new URL(image.props.source);
  expect(url.pathname).toBe("/Items/series-1/Images/Primary");
  expect(url.searchParams.get("tag")).toBe("series-poster");
});
