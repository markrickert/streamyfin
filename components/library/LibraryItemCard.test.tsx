import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client/models";
import {
  QueryCache,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react-native";
import { createStore, Provider as JotaiProvider } from "jotai";
import { PixelRatio } from "react-native";
import { apiAtom } from "@/providers/JellyfinProvider";
import { makeApi } from "@/test-utils/jellyfinApi";
import { LibraryItemCard } from "./LibraryItemCard";

jest.mock("@/providers/JellyfinProvider", () => {
  const { atom } = jest.requireActual("jotai");
  return {
    apiAtom: atom(null),
    userAtom: atom({ Id: "user-1" }),
  };
});
let mockLibraryOptions = {
  display: "row",
  imageStyle: "cover",
  showStats: true,
};
jest.mock("@/utils/atoms/settings", () => ({
  useSettings: () => ({ settings: { libraryOptions: mockLibraryOptions } }),
}));
jest.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
jest.mock("@/components/common/ServerImage", () => ({
  Image: ({ source }: { source: { uri: string } }) => {
    const { View } = jest.requireActual("react-native");
    return <View testID={source.uri} />;
  },
}));
// Navigation is not what is under test; the card shows up as its content.
jest.mock("../common/TouchableItemRouter", () => ({
  TouchableItemRouter: ({ children }: { children: React.ReactNode }) =>
    children,
}));

const LIBRARY: BaseItemDto = {
  Id: "library-1",
  Name: "Movies",
  CollectionType: "movies",
  ImageTags: { Primary: "tag" },
};

const renderCard = async () => {
  /** What the app's own query cache would have handed to Sentry. */
  const errors: Error[] = [];
  // No garbage collection timer nor retry: either keeps Jest from exiting.
  const client = new QueryClient({
    queryCache: new QueryCache({ onError: (error) => errors.push(error) }),
    defaultOptions: {
      queries: { gcTime: Number.POSITIVE_INFINITY, retry: false },
    },
  });
  const store = createStore();
  await render(
    <QueryClientProvider client={client}>
      <JotaiProvider store={store}>
        <LibraryItemCard library={LIBRARY} />
      </JotaiProvider>
    </QueryClientProvider>,
  );
  // Lets a query that started on mount settle.
  await act(async () => {});
  return { store, errors };
};

describe("LibraryItemCard", () => {
  beforeEach(() => {
    mockLibraryOptions = {
      display: "row",
      imageStyle: "cover",
      showStats: true,
    };
  });

  // Sentry REACT-NATIVE-D7: the card mounted before the api was restored and
  // its count query handed the null api to the SDK, which threw "Cannot read
  // property 'configuration' of null".
  test("does not ask for the item count before the api is there", async () => {
    const { errors } = await renderCard();

    expect(errors).toEqual([]);
  });

  // The query key does not carry the api, so a count that failed on a null
  // api never came back on its own.
  test("asks for the item count once the api arrives", async () => {
    const api = makeApi();
    // The SDK writes the query into the url.
    api.mock.onGet(/\/Items\?/).reply(200, { Items: [], TotalRecordCount: 12 });
    const { store, errors } = await renderCard();

    await act(async () => store.set(apiAtom, api));

    await waitFor(() =>
      expect(screen.getByText("12 library.item_types.movies")).toBeTruthy(),
    );
    expect(api.mock.history.get).toHaveLength(1);
    const query = new URL(api.mock.history.get[0].url ?? "").searchParams;
    expect(Object.fromEntries(query)).toEqual({
      userId: "user-1",
      parentId: "library-1",
      recursive: "true",
      limit: "0",
      includeItemTypes: "Movie",
    });
    expect(errors).toEqual([]);
  });

  test("a cover requests its measured width rather than a fixed image size", async () => {
    mockLibraryOptions = {
      display: "card",
      imageStyle: "cover",
      showStats: false,
    };
    const api = makeApi();
    api.mock.onGet(/\/Items\?/).reply(200, { Items: [], TotalRecordCount: 12 });
    const { store } = await renderCard();
    await act(async () => store.set(apiAtom, api));

    expect(screen.queryByTestId(/\/Items\/library-1\/Images\//)).toBeNull();
    await fireEvent(screen.getByTestId("library-cover"), "layout", {
      nativeEvent: { layout: { width: 320, height: 80 } },
    });
    expect(
      screen.getByTestId(
        new RegExp(
          `/Items/library-1/Images/Primary\\?fillWidth=${PixelRatio.getPixelSizeForLayoutSize(320)}&`,
        ),
      ),
    ).toBeTruthy();
    await fireEvent(screen.getByTestId("library-cover"), "layout", {
      nativeEvent: { layout: { width: 240, height: 80 } },
    });
    expect(
      screen.getByTestId(
        new RegExp(
          `/Items/library-1/Images/Primary\\?fillWidth=${PixelRatio.getPixelSizeForLayoutSize(240)}&`,
        ),
      ),
    ).toBeTruthy();
  });
});
