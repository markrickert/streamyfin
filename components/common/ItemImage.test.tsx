import { render, screen } from "@testing-library/react-native";
import { Dimensions, PixelRatio } from "react-native";
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
