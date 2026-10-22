import { render, screen } from "@testing-library/react-native";
import { stubReactNative } from "@/test-utils/reactNative";

jest.mock("expo", () => ({
  ...jest.requireActual("expo"),
  requireNativeView: () => {
    const { View } = jest.requireActual("react-native");
    return (props: object) => <View testID='native-poster' {...props} />;
  },
}));
jest.mock("@/hooks/useHeadersForUrl", () => ({
  useHeadersForUrl: jest.fn(),
}));
jest.mock("./GlassPosterModule", () => ({
  isGlassEffectAvailable: () => true,
}));

stubReactNative({ OS: "ios", isTV: true });

const mockHeaders = jest.requireMock("@/hooks/useHeadersForUrl")
  .useHeadersForUrl as jest.Mock;
// GlassPosterView reads Platform when it loads, so it must be required
// after stubReactNative, not imported.
const GlassPosterView = require("./GlassPosterView").default;

const props = {
  imageUrl: "https://jellyfin.example/Items/1/Images/Primary",
  aspectRatio: 10 / 15,
  cornerRadius: 24,
  progress: 0,
  showWatchedIndicator: false,
  isFocused: false,
  width: 200,
};

const nativePayload = () =>
  JSON.parse(screen.getByTestId("native-poster").props.headersJson);

test("sends proxy headers scoped to the image URL they were resolved for", async () => {
  mockHeaders.mockReturnValue({ "CF-Access-Client-Id": "secret" });
  const { rerender } = await render(<GlassPosterView {...props} />);
  expect(mockHeaders).toHaveBeenCalledWith(props.imageUrl);
  expect(nativePayload()).toEqual({
    url: props.imageUrl,
    headers: { "CF-Access-Client-Id": "secret" },
  });

  mockHeaders.mockReturnValue({ "CF-Access-Client-Id": "new-secret" });
  await rerender(<GlassPosterView {...props} />);
  expect(nativePayload().headers).toEqual({
    "CF-Access-Client-Id": "new-secret",
  });

  mockHeaders.mockReturnValue(undefined);
  await rerender(
    <GlassPosterView {...props} imageUrl='https://image.tmdb.org/poster' />,
  );
  expect(nativePayload()).toEqual({
    url: "https://image.tmdb.org/poster",
    headers: {},
  });
});

test("sends no URL and no headers when there is no image", async () => {
  mockHeaders.mockReturnValue(undefined);
  await render(<GlassPosterView {...props} imageUrl={null} />);
  expect(nativePayload()).toEqual({ url: null, headers: {} });
});
