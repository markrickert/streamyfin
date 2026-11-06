import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client/models";
import { makeApi } from "@/test-utils/jellyfinApi";
import { syncPlayQueuePosterUrl } from "./queueDisplay";

jest.mock("@/utils/customHeaders", () =>
  jest.requireActual("@/test-utils/customHeaders").customHeadersModule(),
);

const api = makeApi();

test("an episode queue row borrows the tagged series poster", () => {
  const item: BaseItemDto = {
    Id: "episode-1",
    Type: "Episode",
    SeriesId: "series-1",
    SeriesPrimaryImageTag: "series-tag",
    ImageTags: { Primary: "still-tag" },
  };
  const url = new URL(syncPlayQueuePosterUrl(api, item)!);
  expect(url.pathname).toBe("/Items/series-1/Images/Primary");
  expect(url.searchParams.get("tag")).toBe("series-tag");
  expect(Number(url.searchParams.get("fillWidth"))).toBeGreaterThan(0);
});

test("a queue row without a matched image tag has no poster URL", () => {
  expect(
    syncPlayQueuePosterUrl(api, {
      Id: "episode-1",
      Type: "Episode",
      SeriesId: "series-1",
    }),
  ).toBeNull();
});
