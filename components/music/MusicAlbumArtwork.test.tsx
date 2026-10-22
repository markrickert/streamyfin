import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client/models";
import { render, screen } from "@testing-library/react-native";
import { PixelRatio } from "react-native";
import { MusicAlbumCard } from "./MusicAlbumCard";
import { MusicAlbumRowCard } from "./MusicAlbumRowCard";

jest.mock("@/providers/JellyfinProvider", () => {
  const { atom } = jest.requireActual("jotai");
  return { apiAtom: atom({ basePath: "http://server" }) };
});
jest.mock("@/hooks/useAppRouter", () => ({
  __esModule: true,
  default: () => ({ push: jest.fn() }),
}));
jest.mock("@/components/common/ServerImage", () => ({
  Image: ({ source }: { source: { uri: string } }) => {
    const { View } = jest.requireActual("react-native");
    return <View testID={source.uri} />;
  },
}));

const album: BaseItemDto = {
  Id: "album-1",
  Type: "MusicAlbum",
  Name: "Album",
  ImageTags: { Primary: "album-tag" },
};

test("album rows request the pixels drawn in their 56-point thumbnail", async () => {
  await render(<MusicAlbumRowCard album={album} />);
  expect(
    screen.getByTestId(
      new RegExp(
        `\\/Items\\/album-1\\/Images\\/Primary\\?fillWidth=${PixelRatio.getPixelSizeForLayoutSize(56)}&`,
      ),
    ),
  ).toBeTruthy();
});

test("album cards resize their request when the card width changes", async () => {
  const { rerender } = await render(
    <MusicAlbumCard album={album} width={150} />,
  );
  expect(
    screen.getByTestId(
      new RegExp(
        `\\/Items\\/album-1\\/Images\\/Primary\\?fillWidth=${PixelRatio.getPixelSizeForLayoutSize(150)}&`,
      ),
    ),
  ).toBeTruthy();

  await rerender(<MusicAlbumCard album={album} width={200} />);
  expect(
    screen.getByTestId(
      new RegExp(
        `\\/Items\\/album-1\\/Images\\/Primary\\?fillWidth=${PixelRatio.getPixelSizeForLayoutSize(200)}&`,
      ),
    ),
  ).toBeTruthy();
});
