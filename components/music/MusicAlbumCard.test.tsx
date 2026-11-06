import { render, screen } from "@testing-library/react-native";
import { PixelRatio } from "react-native";
import { MusicAlbumCard } from "./MusicAlbumCard";

jest.mock("@/providers/JellyfinProvider", () => ({
  apiAtom: jest
    .requireActual("jotai")
    .atom({ basePath: "https://jellyfin.example.com" }),
}));
jest.mock("@/utils/customHeaders", () =>
  jest.requireActual("@/test-utils/customHeaders").customHeadersModule(),
);
jest.mock(
  "@/components/common/ServerImage",
  () => jest.requireActual("@/test-utils/serverImage").serverImageModule,
);
jest.mock("@/hooks/useAppRouter", () => () => ({ push: () => {} }));

test("sizes album artwork for the drawn square and keeps the image tag", async () => {
  await render(
    <MusicAlbumCard
      album={{
        Id: "album-1",
        Type: "MusicAlbum",
        ImageTags: { Primary: "album-tag" },
      }}
      width={110}
    />,
  );

  const image = screen.getByTestId(/^image /);
  const url = new URL(
    typeof image.props.source === "string"
      ? image.props.source
      : image.props.source.uri,
  );
  expect(url.pathname).toBe("/Items/album-1/Images/Primary");
  expect(url.searchParams.get("tag")).toBe("album-tag");
  expect(Number(url.searchParams.get("fillWidth"))).toBeGreaterThanOrEqual(
    110 * PixelRatio.get(),
  );
  expect(Number(url.searchParams.get("fillWidth"))).toBeLessThan(350);
});
