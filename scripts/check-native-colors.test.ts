import {
  findNativeColorLiterals,
  isGeneratedPalette,
  scanNativeSources,
} from "./check-native-colors";

const flagged = (file: string, line: string) =>
  findNativeColorLiterals(file, line).length;

describe("findNativeColorLiterals", () => {
  it.each([
    "val a = Color(0xFF9334E9)",
    "val a = Color(0x99000000)",
    "val a = Color.White",
    "val a = Color.Black.copy(alpha = 0.5f)",
    "val a = Color.Red",
    "val a = Color.Gray",
    "val a = Color.argb(0, 0, 0, 0)",
    "setBackgroundColor(Color.BLACK)",
    'val a = Color.parseColor("#9334E9")',
    "val a = Color(red = 0.5f, green = 0f, blue = 0f)",
    "val a = Color.rgb(255, 0, 0)",
    "val a = android.graphics.Color.rgb(255, 0, 0)",
    "val a = Color.valueOf(1f, 0f, 0f)",
    "val a = Color.hsv(10f, 1f, 1f)",
    'val a = Color.parseColor("#FFF")',
    'val a = "#fff".toColorInt()',
    "val a = Colors.white.copy(alpha = 0.37f)",
    "val a = Color(",
  ])("flags the Kotlin line %s", (line) => {
    expect(flagged("A.kt", line)).toBe(1);
  });

  it.each([
    "val a = Colors.primary",
    "val a = Colors.white10",
    "val a = Color.Transparent",
    "val a = LocalContentColor.current.copy(alpha = 0.7f)",
    "val a = Color.alpha(value) > 0",
    "val a = Color.argb(a, r, g, b)",
    "val flags = 0xFF",
    "val a = Colors.black // 0xFF9334E9 was the old value",
    "val a = Color.White // color-literal-ok: user-picked subtitle color",
  ])("allows the Kotlin line %s", (line) => {
    expect(flagged("A.kt", line)).toBe(0);
  });

  it.each([
    ".foregroundStyle(.white)",
    ".foregroundStyle(.white.opacity(0.7))",
    "let a = Color.white",
    "let a = Color.black.opacity(0.5)",
    "let a = Color(white: 0.16)",
    "let a = Color(red: 0.5, green: 0, blue: 0)",
    "let a = Color(.sRGB, red: 1, green: 0, blue: 0, opacity: 1)",
    "let a = UIColor.black.cgColor",
    "let a = UIColor(red: 1, green: 0, blue: 0, alpha: 1)",
    ".foregroundStyle(.red)",
    ".foregroundStyle(.orange)",
    'let a = Color(hex: "#9334E9")',
    "let a = 0xFF9334E9",
    "let a = UIColor.systemRed",
    "let a = Color(.systemGray6)",
    "let a = Color(UIColor.systemGray)",
    "let a = UIColor.darkGray",
    "let a = CGColor(red: 1, green: 0, blue: 0, alpha: 1)",
    "let a = CGColor(gray: 0.5, alpha: 1)",
    "let a = UIColor.init(red: 1, green: 0, blue: 0, alpha: 1)",
    "let a = Color.init(white: 0.5)",
    "let a = UIColor(displayP3Red: 1, green: 0, blue: 0, alpha: 1)",
    "let a = Color(",
    "let a = Colors.white.opacity(0.37)",
  ])("flags the Swift line %s", (line) => {
    expect(flagged("A.swift", line)).toBe(1);
  });

  it.each([
    ".foregroundStyle(Colors.white)",
    ".foregroundStyle(.secondary)",
    ".foregroundStyle(.primary)",
    "let a = Color.secondary",
    "let a = Color.clear",
    "hosting.view.backgroundColor = .clear",
    ".opacity(0.7)",
    "let a = UIColor(Colors.black).cgColor",
    ".foregroundStyle(.white) // color-literal-ok: system chrome",
    "// .foregroundStyle(.white)",
  ])("allows the Swift line %s", (line) => {
    expect(flagged("A.swift", line)).toBe(0);
  });

  it("recognises a generated palette by its header, not its file name", () => {
    expect(
      isGeneratedPalette("// Generated from constants/Colors.ts by x\n"),
    ).toBe(true);
    expect(isGeneratedPalette("val a = Color(0xFF000000)\n")).toBe(false);
  });

  it("reports the line number", () => {
    const [hit] = findNativeColorLiterals(
      "A.kt",
      "val a = Colors.black\nval b = Color.White",
    );
    expect(hit.line).toBe(2);
  });
});

describe("native sources", () => {
  it("hold no color literal outside the generated palettes", () => {
    expect(scanNativeSources()).toEqual([]);
  });
});
