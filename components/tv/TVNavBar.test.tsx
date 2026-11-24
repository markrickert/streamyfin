import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { TVNavBar } from "./TVNavBar";

// The bar only needs the inactivity timer's side-effect boundary in this test.
jest.mock("@/providers/InactivityProvider", () => ({
  useInactivity: () => ({ resetInactivityTimer: () => {} }),
}));

const tabs = [
  { key: "home", label: "Home" },
  { key: "library", label: "Library" },
];
const tabButtons = () =>
  screen.root.queryAll((i) => i.props.hasTVPreferredFocus !== undefined);

describe("TVNavBar", () => {
  test("releases the active tab's preferred focus after leaving the bar", async () => {
    const props = { tabs, activeTabKey: "library", onTabChange: jest.fn() };
    const { rerender } = await render(<TVNavBar {...props} />);
    expect(tabButtons().map((tab) => tab.props.hasTVPreferredFocus)).toEqual([
      false,
      true,
    ]);
    await act(async () => {
      fireEvent(tabButtons()[1], "focus");
      fireEvent(tabButtons()[1], "blur");
    });
    expect(tabButtons().map((tab) => tab.props.hasTVPreferredFocus)).toEqual([
      false,
      false,
    ]);
    rerender(<TVNavBar {...props} />);
    expect(tabButtons()[1].props.hasTVPreferredFocus).toBe(false);
  });
});
