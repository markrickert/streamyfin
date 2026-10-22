import type { Api } from "@jellyfin/sdk";
import { File } from "expo-file-system";
import { fakeFiles } from "@/test-utils/fileSystem";
import { stubReactNative } from "@/test-utils/reactNative";
import { clearTVDiscoverySafely, updateTVDiscovery } from "./sync";

jest.mock(
  "expo-file-system",
  () => jest.requireActual("@/test-utils/fileSystem").fileSystemModule,
);
jest.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  digestStringAsync: async () => "a".repeat(64),
}));

const mockSync = jest.fn((_payload: string) => true);
const mockClear = jest.fn(() => true);
const mockWriteTopShelf = jest.fn();
const mockClearTopShelf = jest.fn();
let mockProxyHeaders: Record<string, string> | undefined;

jest.mock("@/modules", () => ({
  syncTvRecommendations: (payload: string) => mockSync(payload),
  clearTvRecommendations: () => mockClear(),
}));
jest.mock("@/utils/topshelf/cache", () => ({
  writeTopShelfPayload: (...args: unknown[]) => mockWriteTopShelf(...args),
  clearTopShelfCacheSafely: (...args: unknown[]) => mockClearTopShelf(...args),
}));
jest.mock("@/utils/customHeaders", () => ({
  getJellyfinHeadersForUrl: () => mockProxyHeaders,
}));

const api = {
  basePath: "https://jellyfin.example",
  accessToken: "SECRET_TOKEN",
  deviceInfo: { id: "device-1" },
} as Api;
const sections = [
  {
    title: "Continue",
    items: [
      {
        Id: "movie-1",
        Type: "Movie" as const,
        Name: "Movie",
        ImageTags: { Primary: "p" },
      },
    ],
  },
];

beforeEach(() => {
  stubReactNative({ OS: "android", isTV: true });
  fakeFiles.clear();
  mockSync.mockClear();
  mockClear.mockClear();
  mockWriteTopShelf.mockClear();
  mockClearTopShelf.mockClear();
  mockProxyHeaders = { "CF-Access-Client-Id": "proxy-secret" };
});

test("publishes only local artwork after downloading with auth and proxy headers", async () => {
  let requestHeaders: Record<string, string> | undefined;
  let requestUrl: string | undefined;
  const download = jest
    .spyOn(File, "downloadFileAsync")
    .mockImplementation(async (url, file, options) => {
      requestUrl = url;
      requestHeaders = options?.headers;
      fakeFiles.add((file as File).uri);
      return file as File;
    });
  try {
    await updateTVDiscovery({ api, sections });
  } finally {
    download.mockRestore();
  }

  expect(requestHeaders).toEqual({
    Authorization: 'MediaBrowser DeviceId="device-1", Token="SECRET_TOKEN"',
    "CF-Access-Client-Id": "proxy-secret",
  });
  expect(requestUrl).toContain("format=Jpg");
  const payload = JSON.parse(mockSync.mock.calls[0][0]);
  expect(payload.sections[0].items[0].imageUrl).toMatch(
    /^file:\/\/.*\/[a-f0-9]{64}\.jpg$/,
  );
  expect(JSON.stringify(payload)).not.toContain("proxy-secret");
  expect(JSON.stringify(payload)).not.toContain("SECRET_TOKEN");
});

test("reuses the cached image on the next home refresh", async () => {
  await updateTVDiscovery({ api, sections });
  await updateTVDiscovery({ api, sections });

  expect(fakeFiles.downloads()).toHaveLength(1);
  expect(mockSync).toHaveBeenCalledTimes(2);
});

test("overlapping home refreshes share one download and publish only the latest", async () => {
  let finishDownload!: () => void;
  const download = jest.spyOn(File, "downloadFileAsync").mockImplementation(
    async (_url, file) =>
      new Promise((resolve) => {
        finishDownload = () => {
          fakeFiles.add(file.uri);
          resolve(file as File);
        };
      }),
  );
  try {
    const first = updateTVDiscovery({ api, sections });
    const second = updateTVDiscovery({ api, sections });
    for (let tick = 0; tick < 5; tick++) await Promise.resolve();
    expect(download).toHaveBeenCalledTimes(1);
    finishDownload();
    await Promise.all([first, second]);
    expect(mockSync).toHaveBeenCalledTimes(1);
  } finally {
    download.mockRestore();
  }
});

test("a failed protected download leaves no inaccessible URL in the launcher", async () => {
  const download = jest
    .spyOn(File, "downloadFileAsync")
    .mockRejectedValue(new Error("offline"));
  try {
    await updateTVDiscovery({ api, sections });
  } finally {
    download.mockRestore();
  }

  const payload = JSON.parse(mockSync.mock.calls[0][0]);
  expect(payload.sections[0].items[0].imageUrl).toBeUndefined();
});

test("Top Shelf receives a local reference instead of a protected URL", async () => {
  stubReactNative({ OS: "ios", isTV: true });
  await updateTVDiscovery({ api, sections });

  expect(mockWriteTopShelf).toHaveBeenCalledTimes(1);
  const [payload] = mockWriteTopShelf.mock.calls[0];
  expect(payload.sections[0].items[0].imageUrl).toMatch(/^file:/);
  expect(JSON.stringify(payload)).not.toContain("proxy-secret");
});

test("a logout must never publish a download that completed afterward", async () => {
  let finishDownload!: () => void;
  const download = jest.spyOn(File, "downloadFileAsync").mockImplementation(
    async (_url, file) =>
      new Promise((resolve) => {
        finishDownload = () => {
          fakeFiles.add(file.uri);
          resolve(file as File);
        };
      }),
  );

  try {
    const pending = updateTVDiscovery({ api, sections });
    await Promise.resolve();
    clearTVDiscoverySafely();
    finishDownload();
    await pending;
    expect(mockSync).not.toHaveBeenCalled();
    expect(mockClear).toHaveBeenCalled();
    expect(
      fakeFiles.remaining().filter((path) => path.endsWith(".jpg")),
    ).toEqual([]);
  } finally {
    download.mockRestore();
  }
});

test("without proxy headers, keeps the existing remote URL path", async () => {
  mockProxyHeaders = undefined;
  await updateTVDiscovery({ api, sections });

  expect(fakeFiles.downloads()).toHaveLength(0);
  expect(
    JSON.parse(mockSync.mock.calls[0][0]).sections[0].items[0].imageUrl,
  ).toContain("https://jellyfin.example/Items/");
});
