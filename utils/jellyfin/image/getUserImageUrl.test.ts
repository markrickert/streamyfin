import { setJellyfinHeaders } from "@/test-utils/customHeaders";
import { getJellyfinHeadersForUrl } from "@/utils/customHeaders";
import { getUserImageUrl } from "./getUserImageUrl";

jest.mock("@/utils/customHeaders", () =>
  jest.requireActual("@/test-utils/customHeaders").customHeadersModule(),
);

afterEach(() => setJellyfinHeaders());

test("builds a tagged public user portrait before an authenticated API exists", () => {
  const serverAddress = "https://jellyfin.example.com/base";
  setJellyfinHeaders({ "X-Gateway": "saved" }, serverAddress);
  const url = getUserImageUrl({
    serverAddress,
    userId: "user-1",
    primaryImageTag: "tag +/1",
    width: 300,
  });

  expect(new URL(url!).pathname).toBe("/base/Users/user-1/Images/Primary");
  expect(new URL(url!).searchParams.get("tag")).toBe("tag +/1");
  expect(new URL(url!).searchParams.get("width")).toBe("300");
  expect(getJellyfinHeadersForUrl(url, serverAddress)).toEqual({
    "X-Gateway": "saved",
  });
  expect(
    getJellyfinHeadersForUrl("https://other.example.com/art", serverAddress),
  ).toBeUndefined();
});

test("keeps unavailable servers, users and tags as a no-image state", () => {
  expect(
    getUserImageUrl({
      serverAddress: "",
      userId: "user-1",
      primaryImageTag: "tag",
    }),
  ).toBeNull();
  expect(
    getUserImageUrl({
      serverAddress: "https://jellyfin.example.com",
      userId: "",
      primaryImageTag: "tag",
    }),
  ).toBeNull();
  expect(
    getUserImageUrl({
      serverAddress: "https://jellyfin.example.com",
      userId: "user-1",
    }),
  ).toBeNull();
});
