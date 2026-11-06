import { imageUrlViolations } from "./imageUrlOwnership";

const file = "components/Example.tsx";
const fixture = (source: string) => source.replaceAll("%{", "${");

test.each([
  [
    "template",
    "const url = `%{api.basePath}/Items/%{item.Id}/Images/Primary?fillWidth=600`;",
  ],
  [
    "concatenation",
    'const url = api.basePath + "/Items/" + id + "/Images/Thumb";',
  ],
  [
    "URL constructor",
    'const url = new URL("/Items/" + id + "/Images/Primary", api.basePath);',
  ],
  ["user portrait", "const url = `%{base}/Users/%{userId}/Images/Primary`;"],
  [
    "SDK URL builder",
    "const url = getImageApi(api).getItemImageUrlById(id, 'Primary');",
  ],
  ["SDK user URL builder", "const url = images.getUserImageUrl(user, {});"],
  [
    "image-size params",
    "const params = new URLSearchParams({ fillWidth: '600', fillHeight: '400' });",
  ],
  [
    "bounded image params",
    "const params = new URLSearchParams({ maxWidth: '600', maxHeight: '400' });",
  ],
  [
    "path segments",
    'const path = ["Items", id, "Images", "Primary"].join("/");',
  ],
  ["SDK API factory", "const images = getImageApi(api);"],
  ["maxWidth/maxHeight query", "const query = `?maxWidth=600&maxHeight=400`;"],
])("rejects %s image URL construction outside image modules", (_, code) => {
  expect(imageUrlViolations(fixture(code), file)).not.toEqual([]);
});

test("checks native image paths", () => {
  expect(
    imageUrlViolations(
      'val url = "$base/Items/$id/Images/Primary"',
      "modules/tv-recommendations/android/src/main/Foo.kt",
    ),
  ).not.toEqual([]);
});

test("rejects image query assembly even if the path and params are separated", () => {
  expect(
    imageUrlViolations(
      fixture(
        "const path = `%{base}/Items/%{id}/Images/Primary`;\nconst query = `?fillHeight=%{height}`;",
      ),
      file,
    ),
  ).not.toEqual([]);
});

test.each([
  [
    "approved URL serializer",
    "utils/jellyfin/image/itemImageUrl.ts",
    "const path = `%{base}/Items/%{id}/Images/Primary`;",
  ],
  [
    "test data",
    "components/Example.test.ts",
    'const path = "/Items/123/Images/Primary";',
  ],
  [
    "streaming",
    file,
    "const path = `%{base}/Items/%{id}/PlaybackInfo?mediaSourceId=%{source}`;",
  ],
  [
    "external image",
    file,
    'const url = "https://external.example/art?maxWidth=120";',
  ],
  [
    "unrelated URL query",
    file,
    'const params = new URLSearchParams({ maxWidth: "500" });',
  ],
  [
    "documented trickplay",
    "utils/jellyfin/image/trickplaySheetUrl.ts",
    "const path = `%{base}/Videos/%{id}/Trickplay/%{index}`;",
  ],
  ["comment", file, "// `%{base}/Items/%{id}/Images/Primary`"],
])("allows %s", (_, path, code) => {
  expect(imageUrlViolations(fixture(code), path)).toEqual([]);
});
