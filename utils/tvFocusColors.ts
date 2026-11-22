import { Colors } from "@/constants/Colors";

/** Text and icons on a TV control: black on the white fill of the focus, foreground otherwise. */
export const tvFocusedTextColor = (focused: boolean) =>
  focused ? Colors.black : Colors.foreground;
