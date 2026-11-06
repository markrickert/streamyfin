import { render, screen } from "@testing-library/react-native";
import { CurrentSeries } from "./CurrentSeries";

jest.mock("@/providers/JellyfinProvider", () => ({
  apiAtom: jest.requireActual("jotai").atom({
    basePath: "https://jellyfin.example.com",
  }),
}));
jest.mock("@/components/cards/CardRow", () => {
  const { Text } = jest.requireActual("react-native");
  return {
    CardRow: ({ cards }: { cards: Array<{ imageUrl?: string | null }> }) => (
      <Text testID='series-art'>{cards[0]?.imageUrl}</Text>
    ),
  };
});
jest.mock("@/hooks/useAppRouter", () => ({
  __esModule: true,
  default: () => ({ push: jest.fn() }),
}));
jest.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
jest.mock("@/utils/customHeaders", () =>
  jest.requireActual("@/test-utils/customHeaders").customHeadersModule(),
);

test("the current-series card requests the series poster, not its season", async () => {
  await render(
    <CurrentSeries
      item={{
        Id: "episode-1",
        Type: "Episode",
        ParentId: "season-1",
        SeriesId: "series-1",
        SeriesPrimaryImageTag: "series-tag",
      }}
    />,
  );
  const url = new URL(screen.getByTestId("series-art").props.children);
  expect(url.pathname).toBe("/Items/series-1/Images/Primary");
  expect(url.searchParams.get("tag")).toBe("series-tag");
});
