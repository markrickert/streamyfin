import fs from "node:fs";
import path from "node:path";
import { Colors } from "../constants/Colors";
import {
  NATIVE_PALETTE_TARGETS,
  nativePaletteTargets,
  renderKotlinPalette,
  renderSwiftPalette,
  renderTailwindConfig,
} from "./native-palette";

const ROOT = path.resolve(__dirname, "..");

describe("renderKotlinPalette", () => {
  const kotlin = renderKotlinPalette("expo.modules.example");

  it("declares the package", () => {
    expect(kotlin).toContain("package expo.modules.example\n");
  });

  it("writes an opaque hex token as ARGB", () => {
    expect(kotlin).toContain("val primary = Color(0xFF9334E9)");
  });

  it("writes an rgba token with its alpha rounded to a byte", () => {
    expect(kotlin).toContain("val white10 = Color(0x1AFFFFFF)");
    expect(kotlin).toContain("val dangerSubtle = Color(0x33EF4444)");
  });

  it("maps transparent to Color.Transparent", () => {
    expect(kotlin).toContain("val transparent = Color.Transparent");
  });

  it("has a token for every color of Colors", () => {
    for (const name of Object.keys(Colors)) {
      expect(kotlin).toContain(`val ${name} = `);
    }
  });
});

describe("renderKotlinPalette without Compose", () => {
  const kotlin = renderKotlinPalette("expo.modules.example", false);

  it("writes each token as an ARGB Int for android.graphics views", () => {
    expect(kotlin).toContain("const val primary = 0xFF9334E9.toInt()");
    expect(kotlin).toContain("const val transparent = 0x00000000");
  });

  it("does not import Compose", () => {
    expect(kotlin).not.toContain("androidx.compose");
  });
});

describe("renderSwiftPalette", () => {
  const swift = renderSwiftPalette();

  it("writes an opaque hex token as sRGB channels", () => {
    expect(swift).toContain(
      "static let primary = Color(.sRGB, red: 147 / 255, green: 52 / 255, blue: 233 / 255, opacity: 1)",
    );
  });

  it("writes an rgba token with its alpha as opacity", () => {
    expect(swift).toContain(
      "static let black60 = Color(.sRGB, red: 0 / 255, green: 0 / 255, blue: 0 / 255, opacity: 0.6)",
    );
  });

  it("maps transparent to Color.clear", () => {
    expect(swift).toContain("static let transparent = Color.clear");
  });

  it("has a token for every color of Colors", () => {
    for (const name of Object.keys(Colors)) {
      expect(swift).toContain(`static let ${name} = `);
    }
  });
});

describe("renderTailwindConfig", () => {
  const tailwind = renderTailwindConfig();

  it("names a color in kebab-case, quoted only when it needs it", () => {
    expect(tailwind).toContain('"foreground-muted": "#9ca3af",');
    expect(tailwind).toContain('      primary: "#9334E9",');
  });

  it("keeps an rgba token as written", () => {
    expect(tailwind).toContain('"danger-subtle": "rgba(239, 68, 68, 0.2)",');
  });

  it("leaves out the white and black opacity variants", () => {
    expect(tailwind).not.toMatch(/^\s+(white|black)\d+:/m);
  });
});

describe("NATIVE_PALETTE_TARGETS", () => {
  it.each(NATIVE_PALETTE_TARGETS)(
    "$path matches what the generator writes",
    ({ path: file, content }) => {
      expect(fs.readFileSync(path.join(ROOT, file), "utf8")).toBe(content);
    },
  );
});

describe("nativePaletteTargets", () => {
  const palette = { ...Colors, brandNew: "#123456" };
  const { transparent: _removed, ...withoutTransparent } = Colors;

  it("carries an added token into every target", () => {
    const targets = nativePaletteTargets(palette);
    expect(targets).toHaveLength(NATIVE_PALETTE_TARGETS.length);
    for (const { content } of targets) {
      expect(content).toMatch(/brandNew\b|brand-new/);
    }
  });

  it("drops a deleted token from every target", () => {
    for (const { content } of nativePaletteTargets(withoutTransparent)) {
      expect(content).not.toMatch(/transparent\b/);
    }
  });
});
