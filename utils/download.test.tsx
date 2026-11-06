import { act, renderHook } from "@testing-library/react-native";
import useDownloadHelper from "./download";

const mockSaveImage = jest.fn();
const mockGetItem = jest.fn();

jest.mock("@/providers/JellyfinProvider", () => ({
  apiAtom: jest.requireActual("jotai").atom({
    basePath: "https://jellyfin.example.com",
  }),
}));
jest.mock("@/hooks/useImageStorage", () => ({
  __esModule: true,
  default: () => ({ saveImage: mockSaveImage }),
}));
jest.mock("@/utils/mmkv", () => ({
  storage: { getString: () => undefined },
}));
jest.mock("@/utils/customHeaders", () =>
  jest.requireActual("@/test-utils/customHeaders").customHeadersModule(),
);
jest.mock("@jellyfin/sdk/lib/utils/api", () => ({
  getLibraryApi: () => ({ getItem: mockGetItem }),
}));

beforeEach(() => {
  jest.clearAllMocks();
});

test("downloads a tagged series cover even when an episode does not carry its tag", async () => {
  mockGetItem.mockResolvedValue({
    data: { Id: "series-1", ImageTags: { Primary: "series-tag" } },
  });
  const { result } = await renderHook(() => useDownloadHelper());

  await act(async () => {
    await result.current.saveSeriesPrimaryImage({
      Id: "episode-1",
      Type: "Episode",
      SeriesId: "series-1",
    });
  });

  expect(mockSaveImage).toHaveBeenCalledTimes(1);
  expect(mockGetItem).toHaveBeenCalledWith(
    expect.objectContaining({ itemId: "series-1" }),
  );
  const [id, rawUrl] = mockSaveImage.mock.calls[0];
  const url = new URL(rawUrl);
  expect(id).toBe("series-1");
  expect(url.pathname).toBe("/Items/series-1/Images/Primary");
  expect(url.searchParams.get("tag")).toBe("series-tag");
});

test("uses the episode's matched series tag without another request", async () => {
  const { result } = await renderHook(() => useDownloadHelper());

  await act(async () => {
    await result.current.saveSeriesPrimaryImage({
      Id: "episode-1",
      Type: "Episode",
      SeriesId: "series-1",
      SeriesPrimaryImageTag: "known-tag",
    });
  });

  expect(mockGetItem).not.toHaveBeenCalled();
  const [, rawUrl] = mockSaveImage.mock.calls[0];
  expect(new URL(rawUrl).searchParams.get("tag")).toBe("known-tag");
});

test("does not save a tagless URL when the series has no image", async () => {
  mockGetItem.mockResolvedValue({ data: { Id: "series-1", ImageTags: {} } });
  const { result } = await renderHook(() => useDownloadHelper());

  await act(async () => {
    await result.current.saveSeriesPrimaryImage({
      Id: "episode-1",
      Type: "Episode",
      SeriesId: "series-1",
    });
  });

  expect(mockSaveImage).not.toHaveBeenCalled();
});
