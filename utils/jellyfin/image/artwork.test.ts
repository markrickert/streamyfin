import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client/models";
import { PixelRatio } from "react-native";
import { MAX_FULLSCREEN_IMAGE_PIXELS } from "@/constants/Images";
import { setJellyfinHeaders } from "@/test-utils/customHeaders";
import { makeApi } from "@/test-utils/jellyfinApi";
import { getArtwork, getArtworkByOwner, getMusicArtwork } from "./artwork";

jest.mock("@/utils/customHeaders", () =>
  jest.requireActual("@/test-utils/customHeaders").customHeadersModule(),
);

const api = makeApi();
const movie: BaseItemDto = {
  Id: "movie-1",
  Type: "Movie",
  ImageTags: { Primary: "poster" },
  BackdropImageTags: ["wide"],
};
const backdrop = (width: number, height: number) =>
  getArtwork({ api, item: movie, purpose: "backdrop", box: { width, height } });

afterEach(() => {
  jest.restoreAllMocks();
  setJellyfinHeaders();
});

test("4K backdrop covers its actual box while a smaller target requests less", () => {
  jest.spyOn(PixelRatio, "get").mockReturnValue(1);
  const fourK = new URL(backdrop(3840, 2160)!.uri!);
  const fullHD = new URL(backdrop(1920, 1080)!.uri!);

  expect(Number(fourK.searchParams.get("fillWidth"))).toBeGreaterThanOrEqual(
    3840,
  );
  expect(Number(fourK.searchParams.get("fillHeight"))).toBeGreaterThanOrEqual(
    2160,
  );
  expect(Number(fullHD.searchParams.get("fillWidth"))).toBeLessThan(
    Number(fourK.searchParams.get("fillWidth")),
  );
  expect(Number(fullHD.searchParams.get("fillHeight"))).toBeLessThan(
    Number(fourK.searchParams.get("fillHeight")),
  );
});

test("bounds a very large target's decoded pixel budget", () => {
  jest.spyOn(PixelRatio, "get").mockReturnValue(1);
  const url = new URL(backdrop(7680, 4320)!.uri!);
  expect(
    Number(url.searchParams.get("fillWidth")) *
      Number(url.searchParams.get("fillHeight")),
  ).toBeLessThanOrEqual(MAX_FULLSCREEN_IMAGE_PIXELS);
});

test("selects the parent's backdrop with its matched tag and scoped proxy headers", () => {
  setJellyfinHeaders({ "X-Gateway": "private" }, api.basePath);
  const source = getArtwork({
    api,
    item: {
      Id: "episode-1",
      Type: "Episode",
      ParentBackdropItemId: "series-1",
      ParentBackdropImageTags: ["series-tag"],
      ImageTags: { Primary: "still" },
    },
    purpose: "backdrop",
    box: { width: 320, height: 180 },
  });

  const url = new URL(source!.uri!);
  expect(url.pathname).toBe("/Items/series-1/Images/Backdrop");
  expect(url.searchParams.get("tag")).toBe("series-tag");
  expect(url.searchParams.get("imageIndex")).toBe("0");
  expect(source?.headers).toEqual({ "X-Gateway": "private" });
});

test("returns no URL for an image without a tag and repeats the same URL for a nearby size", () => {
  expect(
    getArtwork({
      api,
      item: { Id: "unknown", Type: "Movie" },
      purpose: "wide",
      box: { width: 200, height: 112 },
    }),
  ).toBeNull();
  expect(backdrop(195, 108)?.uri).toBe(backdrop(200, 112)?.uri);
});

test("fits an episode's series logo without sending crop parameters", () => {
  const source = getArtwork({
    api,
    item: {
      Id: "episode-1",
      Type: "Episode",
      ParentLogoItemId: "series-1",
      ParentLogoImageTag: "logo",
    },
    purpose: "logo",
    box: { width: 320, height: 100 },
  });

  const url = new URL(source!.uri!);
  expect(url.pathname).toBe("/Items/series-1/Images/Logo");
  expect(url.searchParams.get("tag")).toBe("logo");
  expect(url.searchParams.has("fillWidth")).toBe(false);
  expect(url.searchParams.has("fillHeight")).toBe(false);
  expect(Number(url.searchParams.get("maxWidth"))).toBeGreaterThanOrEqual(320);
  expect(Number(url.searchParams.get("maxHeight"))).toBeGreaterThanOrEqual(100);
});

test("an explicit portrait owner requires an id and matching tag", () => {
  setJellyfinHeaders({ "X-Gateway": "private" }, api.basePath);
  const source = getArtworkByOwner({
    api,
    id: "actor-1",
    type: "Primary",
    tag: "actor-tag",
    pixels: { width: 280, height: 280 },
  });

  const url = new URL(source!.uri!);
  expect(url.pathname).toBe("/Items/actor-1/Images/Primary");
  expect(url.searchParams.get("tag")).toBe("actor-tag");
  expect(source?.headers).toEqual({ "X-Gateway": "private" });
  expect(
    getArtworkByOwner({
      api,
      id: "actor-1",
      type: "Primary",
      pixels: { width: 280 },
    }),
  ).toBeNull();
});

test("music artwork uses the tagged album owner at the displayed pixel size", () => {
  const source = getMusicArtwork({
    api,
    item: {
      Id: "track-1",
      Type: "Audio",
      AlbumId: "album-1",
      AlbumPrimaryImageTag: "album-tag",
      ImageTags: { Primary: "track-tag" },
    },
    box: { width: 44, height: 44 },
  });
  const url = new URL(source!.uri!);

  expect(url.pathname).toBe("/Items/album-1/Images/Primary");
  expect(url.searchParams.get("tag")).toBe("album-tag");
  expect(Number(url.searchParams.get("fillWidth"))).toBeGreaterThanOrEqual(44);
  expect(Number(url.searchParams.get("fillWidth"))).toBeLessThan(300);
  expect(
    getMusicArtwork({
      api,
      item: { Id: "track-2", Type: "Audio", AlbumId: "album-2" },
      box: { width: 44, height: 44 },
    }),
  ).toBeNull();
});
