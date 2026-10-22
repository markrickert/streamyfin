import { render, screen } from "@testing-library/react-native";
import { Platform } from "react-native";

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

const mockHeaders = jest.requireMock("@/hooks/useHeadersForUrl")
  .useHeadersForUrl as jest.Mock;
const props = {
  imageUrl: "https://jellyfin.example/Items/1/Images/Primary",
  aspectRatio: 10 / 15,
  cornerRadius: 24,
  progress: 0,
  showWatchedIndicator: false,
  isFocused: false,
  width: 200,
};

test("passes only the image server's current proxy headers to the native poster", async () => {
  const oldOS = Platform.OS;
  const oldIsTV = Platform.isTV;
  Object.defineProperty(Platform, "OS", { configurable: true, value: "ios" });
  Object.defineProperty(Platform, "isTV", { configurable: true, value: true });
  try {
    const GlassPosterView = require("./GlassPosterView").default;
    mockHeaders.mockReturnValue({ "CF-Access-Client-Id": "secret" });
    const { rerender } = await render(<GlassPosterView {...props} />);
    expect(mockHeaders).toHaveBeenCalledWith(props.imageUrl);
    expect(screen.getByTestId("native-poster").props.headersJson).toBe(
      '{"CF-Access-Client-Id":"secret"}',
    );

    mockHeaders.mockReturnValue({ "CF-Access-Client-Id": "new-secret" });
    await rerender(<GlassPosterView {...props} />);
    expect(screen.getByTestId("native-poster").props.headersJson).toBe(
      '{"CF-Access-Client-Id":"new-secret"}',
    );

    mockHeaders.mockReturnValue(undefined);
    await rerender(
      <GlassPosterView {...props} imageUrl='https://image.tmdb.org/poster' />,
    );
    expect(screen.getByTestId("native-poster").props.headersJson).toBe("{}");
  } finally {
    Object.defineProperty(Platform, "OS", { configurable: true, value: oldOS });
    Object.defineProperty(Platform, "isTV", {
      configurable: true,
      value: oldIsTV,
    });
  }
});
