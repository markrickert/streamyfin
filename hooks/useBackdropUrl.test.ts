import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client/models";
import { renderHook } from "@testing-library/react-native";
import { Dimensions, PixelRatio } from "react-native";
import { stubReactNative } from "@/test-utils/reactNative";
import { useBackdropUrl } from "./useBackdropUrl";

stubReactNative();

jest.mock("@/providers/JellyfinProvider", () => {
  const { atom } = jest.requireActual("jotai");
  const { makeApi } = jest.requireActual("@/test-utils/jellyfinApi");
  return { apiAtom: atom(() => makeApi()) };
});

const movie = {
  Id: "movie-1",
  Type: "Movie",
  BackdropImageTags: ["backdrop-tag"],
} satisfies BaseItemDto;

const paramsOf = (url: string | null) => new URL(url ?? "").searchParams;

const onScreen = ({
  width,
  height,
  density,
}: {
  width: number;
  height: number;
  density: number;
}) => {
  jest
    .spyOn(Dimensions, "get")
    .mockReturnValue({ width, height, scale: density, fontScale: 1 });
  jest.spyOn(PixelRatio, "get").mockReturnValue(density);
};

afterEach(() => {
  jest.restoreAllMocks();
});

describe("useBackdropUrl", () => {
  // The window box is the default: a backdrop usually fills the screen.
  // The request must scale with density — #2166 stretched a point-sized
  // request over a 3x screen.
  test.each([
    { density: 1, fillWidth: "390", fillHeight: "844" },
    { density: 2, fillWidth: "780", fillHeight: "1688" },
    { density: 3, fillWidth: "1170", fillHeight: "2532" },
  ])(
    "requests the window's pixels at density $density",
    async ({ density, fillWidth, fillHeight }) => {
      onScreen({ width: 390, height: 844, density });

      const { result } = await renderHook(() => useBackdropUrl(movie));

      expect(result.current).toContain("/Items/movie-1/Images/Backdrop/0?");
      expect(paramsOf(result.current).get("fillWidth")).toBe(fillWidth);
      expect(paramsOf(result.current).get("fillHeight")).toBe(fillHeight);
    },
  );

  test("lets a caller override the box it draws in", async () => {
    onScreen({ width: 1920, height: 1080, density: 1 });

    const { result } = await renderHook(() =>
      useBackdropUrl(movie, { heightPoints: 220 }),
    );

    // A 1920-by-220 library card on a 1x TV asks for exactly that.
    expect(paramsOf(result.current).get("fillWidth")).toBe("1920");
    expect(paramsOf(result.current).get("fillHeight")).toBe("220");
  });

  test("tracks the item as focus moves", async () => {
    onScreen({ width: 1920, height: 1080, density: 1 });

    const { result, rerender } = await renderHook(
      ({ item }: { item: BaseItemDto }) => useBackdropUrl(item),
      { initialProps: { item: movie } },
    );
    await rerender({
      item: {
        Id: "movie-2",
        Type: "Movie",
        BackdropImageTags: ["other-tag"],
      },
    });

    expect(result.current).toContain("/Items/movie-2/Images/Backdrop/0?");
  });

  test("is null for no item", async () => {
    onScreen({ width: 1920, height: 1080, density: 1 });

    const { result } = await renderHook(() => useBackdropUrl(null));

    expect(result.current).toBeNull();
  });
});
