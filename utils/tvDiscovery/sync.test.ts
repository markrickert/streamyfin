import { setJellyfinHeaders } from "@/test-utils/customHeaders";
import { makeApi } from "@/test-utils/jellyfinApi";
import { stubReactNative } from "@/test-utils/reactNative";

const mockImages = new Map<string, string>();
const mockOwner = new Map<string, string>();
const mockDownloads: {
  url: string;
  options?: { headers?: Record<string, string> };
}[] = [];
let mockDownload: (() => Promise<void>) | undefined;

jest.mock("@/utils/customHeaders", () =>
  jest.requireActual("@/test-utils/customHeaders").customHeadersModule(),
);
jest.mock("@/utils/mmkv", () => ({
  storage: {
    getString: (key: string) => mockOwner.get(key),
    set: (key: string, value: string) => mockOwner.set(key, value),
    remove: (key: string) => mockOwner.delete(key),
  },
}));
jest.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "SHA256" },
  digestStringAsync: async (_algorithm: string, text: string) =>
    jest
      .requireActual("node:crypto")
      .createHash("sha256")
      .update(text)
      .digest("hex"),
}));
jest.mock("expo-file-system", () => {
  class MockFile {
    uri: string;
    exists = true;
    constructor(parent: { uri: string }, name: string) {
      this.uri = `${parent.uri}/${name}`;
    }
    delete() {
      this.exists = false;
    }
    static async downloadFileAsync(
      url: string,
      file: MockFile,
      options?: { headers?: Record<string, string> },
    ) {
      mockDownloads.push({ url, options });
      await mockDownload?.();
      return file;
    }
  }
  return { File: MockFile, Paths: { cache: { uri: "file:///cache" } } };
});
jest.mock("@/modules", () => ({
  getCachedTopShelfImage: jest.fn((key: string) => mockImages.get(key) ?? null),
  storeTopShelfImage: jest.fn((key: string) => {
    const url = `file:///shared/${key}.jpg`;
    mockImages.set(key, url);
    return url;
  }),
  pruneTopShelfImages: jest.fn(),
  writeTopShelfCache: jest.fn(() => true),
  clearTopShelfCache: jest.fn(() => {
    mockImages.clear();
    return true;
  }),
  getCachedTvImage: jest.fn((key: string) => mockImages.get(key) ?? null),
  storeTvImage: jest.fn((key: string) => {
    const url = `content://streamyfin.tvrecommendations.artwork/${key}.jpg`;
    mockImages.set(key, url);
    return url;
  }),
  pruneTvImages: jest.fn(),
  syncTvRecommendations: jest.fn(() => true),
  clearTvRecommendations: jest.fn(() => {
    mockImages.clear();
    return true;
  }),
}));

stubReactNative({ OS: "ios", isTV: true });
const { updateTVDiscovery, clearTVDiscoverySafely } =
  require("./sync") as typeof import("./sync");
const modules = require("@/modules") as typeof import("@/modules");
const api = makeApi();

const episode = {
  Id: "episode-1",
  Name: "Pilot",
  Type: "Episode" as const,
  SeriesId: "series-1",
  SeriesPrimaryImageTag: "series-poster",
  ImageTags: { Primary: "episode-still" },
};
const sections = [{ title: "Continue", items: [episode] }];

beforeEach(() => {
  stubReactNative({ OS: "ios", isTV: true });
  clearTVDiscoverySafely();
  jest.clearAllMocks();
  mockImages.clear();
  mockOwner.clear();
  mockDownloads.length = 0;
  mockDownload = undefined;
  setJellyfinHeaders();
});

test("Top Shelf gets only persistent local posters, fetched with scoped credentials and reused", async () => {
  setJellyfinHeaders({ "X-Gateway": "private" }, api.basePath);
  await updateTVDiscovery({ api, userId: "user-1", sections });

  expect(mockDownloads).toHaveLength(1);
  expect(new URL(mockDownloads[0].url).pathname).toBe(
    "/Items/series-1/Images/Primary",
  );
  expect(mockDownloads[0].options?.headers).toEqual(
    expect.objectContaining({
      "X-Gateway": "private",
      Authorization: expect.stringContaining("SECRET_TOKEN"),
    }),
  );
  const payload = JSON.parse(
    jest.mocked(modules.writeTopShelfCache).mock.calls[0][0],
  );
  expect(payload.sections[0].items[0].imageUrl).toMatch(
    /^file:\/\/\/shared\/[a-f0-9]{64}\.jpg$/,
  );
  expect(JSON.stringify(payload)).not.toContain("SECRET_TOKEN");
  expect(JSON.stringify(payload)).not.toContain("private");
  expect(jest.mocked(modules.writeTopShelfCache).mock.calls[0]).toHaveLength(1);
  expect(
    jest.mocked(modules.pruneTopShelfImages).mock.invocationCallOrder[0],
  ).toBeGreaterThan(
    jest.mocked(modules.writeTopShelfCache).mock.invocationCallOrder[0],
  );

  await updateTVDiscovery({ api, userId: "user-1", sections });
  expect(mockDownloads).toHaveLength(1);
});

test("a failed image fetch publishes the tile without artwork", async () => {
  mockDownload = async () => {
    throw new Error("gateway unavailable");
  };
  await updateTVDiscovery({ api, userId: "user-1", sections });
  const payload = JSON.parse(
    jest.mocked(modules.writeTopShelfCache).mock.calls[0][0],
  );
  expect(payload.sections[0].items[0].imageUrl).toBeUndefined();
});

test("a late download after sign-out cannot publish old artwork", async () => {
  let finish!: () => void;
  mockDownload = () =>
    new Promise<void>((resolve) => {
      finish = resolve;
    });
  const pending = updateTVDiscovery({ api, userId: "user-1", sections });
  await Promise.resolve();
  await Promise.resolve();
  clearTVDiscoverySafely();
  finish();
  await pending;
  expect(modules.writeTopShelfCache).not.toHaveBeenCalled();
  expect(modules.storeTopShelfImage).not.toHaveBeenCalled();
});

test("a new account clears previously published artwork before preparing its tiles", async () => {
  await updateTVDiscovery({ api, userId: "user-1", sections });
  const firstImage = JSON.parse(
    jest.mocked(modules.writeTopShelfCache).mock.calls[0][0],
  ).sections[0].items[0].imageUrl;
  const clearsBeforeSwitch = jest.mocked(modules.clearTopShelfCache).mock.calls
    .length;
  await updateTVDiscovery({ api, userId: "user-2", sections });
  const secondImage = JSON.parse(
    jest.mocked(modules.writeTopShelfCache).mock.calls[1][0],
  ).sections[0].items[0].imageUrl;

  expect(modules.clearTopShelfCache).toHaveBeenCalledTimes(
    clearsBeforeSwitch + 1,
  );
  expect(firstImage).not.toBe(secondImage);
  expect(mockImages.size).toBe(1);
});

test("a failed publication keeps the currently published image available", async () => {
  await updateTVDiscovery({ api, userId: "user-1", sections });
  const previousImage = JSON.parse(
    jest.mocked(modules.writeTopShelfCache).mock.calls[0][0],
  ).sections[0].items[0].imageUrl;
  jest.mocked(modules.writeTopShelfCache).mockReturnValueOnce(false);
  jest.mocked(modules.pruneTopShelfImages).mockClear();

  await updateTVDiscovery({
    api,
    userId: "user-1",
    sections: [
      {
        title: "Continue",
        items: [{ ...episode, SeriesPrimaryImageTag: "new-poster-tag" }],
      },
    ],
  });

  expect(modules.pruneTopShelfImages).not.toHaveBeenCalled();
  expect([...mockImages.values()]).toContain(previousImage);
});

test("Android publishes launcher-readable content URIs and no remote fallback", async () => {
  stubReactNative({ OS: "android", isTV: true });
  await updateTVDiscovery({
    api,
    userId: "user-2",
    sections: [
      {
        title: "Continue",
        items: [
          {
            Id: "movie-1",
            Name: "Movie",
            Type: "Movie",
            ImageTags: { Thumb: "thumb" },
          },
        ],
      },
    ],
  });
  const json = jest.mocked(modules.syncTvRecommendations).mock.calls[0][0];
  const imageUrl = JSON.parse(json).sections[0].items[0].imageUrl;
  expect(imageUrl).toMatch(
    /^content:\/\/streamyfin\.tvrecommendations\.artwork\/[a-f0-9]{64}\.jpg$/,
  );
  expect(json).not.toContain("SECRET_TOKEN");
  expect(new URL(mockDownloads[0].url).pathname).toBe(
    "/Items/movie-1/Images/Thumb",
  );
});
