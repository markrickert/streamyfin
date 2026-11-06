import { render, screen } from "@testing-library/react-native";
import { PixelRatio } from "react-native";
import { TVActorCard } from "./TVActorCard";

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
jest.mock("@/constants/TVTypography", () => ({
  useScaledTVTypography: () => ({ callout: 18 }),
}));
jest.mock("./hooks/useTVFocusAnimation", () => ({
  useTVFocusAnimation: () => ({
    focused: false,
    handleFocus: () => {},
    handleBlur: () => {},
    animatedStyle: {},
  }),
}));
jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));

afterEach(() => jest.restoreAllMocks());

test("a TV cast portrait requests its tagged person image for the focused box", async () => {
  await render(
    <TVActorCard
      person={{
        Id: "actor-1",
        Name: "Actor",
        PrimaryImageTag: "face-tag",
      }}
      onPress={() => {}}
    />,
  );

  const image = screen.getByTestId(/^image /);
  const url = new URL(image.props.source.uri);
  expect(url.pathname).toBe("/Items/actor-1/Images/Primary");
  expect(url.searchParams.get("tag")).toBe("face-tag");
  expect(Number(url.searchParams.get("fillWidth"))).toBeGreaterThanOrEqual(
    Math.round(140 * PixelRatio.get() * (750 / 1920) * 1.05),
  );
  expect(Number(url.searchParams.get("fillWidth"))).toBeLessThan(280);
});

test("a TV cast member without artwork keeps a placeholder", async () => {
  await render(
    <TVActorCard
      person={{ Id: "actor-1", Name: "Actor" }}
      onPress={() => {}}
    />,
  );

  expect(screen.queryByTestId(/^image /)).toBeNull();
  expect(screen.getByText("Actor")).toBeTruthy();
});
