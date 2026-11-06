import { render, screen } from "@testing-library/react-native";
import { Image } from "./ServerImage";

jest.mock("expo-image", () => ({
  Image: ({
    source,
    placeholder,
  }: {
    source: unknown;
    placeholder: unknown;
  }) => {
    const React = jest.requireActual("react");
    const { Text, View } = jest.requireActual("react-native");
    return React.createElement(
      View,
      null,
      React.createElement(
        Text,
        { testID: "image-source" },
        JSON.stringify(source),
      ),
      React.createElement(
        Text,
        { testID: "image-placeholder" },
        JSON.stringify(placeholder),
      ),
    );
  },
}));
jest.mock("@/hooks/useHeadersForUrl", () => ({
  useHeadersForUrl: () => undefined,
}));
jest.mock("@/utils/customHeaders", () =>
  jest.requireActual("@/test-utils/customHeaders").customHeadersModule(),
);

test("renders the remote URI without decoding the artwork blurhash as its source", async () => {
  const source = {
    uri: "https://jellyfin.example.com/Items/movie-1/Images/Primary",
    blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
    headers: { "X-Gateway": "private" },
  };
  await render(<Image source={source} />);

  expect(JSON.parse(screen.getByTestId("image-source").props.children)).toEqual(
    {
      uri: source.uri,
      headers: source.headers,
    },
  );
  expect(
    JSON.parse(screen.getByTestId("image-placeholder").props.children),
  ).toEqual({
    blurhash: source.blurhash,
  });
});
