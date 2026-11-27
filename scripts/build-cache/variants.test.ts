import { artifactName, VARIANTS, variantById } from "./variants";

describe("variants", () => {
  it("defines all 13 variants with unique ids", () => {
    expect(VARIANTS).toHaveLength(13);
    const ids = new Set(VARIANTS.map((v) => v.id));
    expect(ids.size).toBe(13);
  });

  it("formats artifact names with recipe and fingerprint hash", () => {
    const sim = variantById("ios-phone-debug-simulator-unsigned");
    expect(sim).toBeDefined();
    expect(artifactName(sim!, "abc123")).toBe(
      "streamyfin-ios-phone-debug-simulator-unsigned-r1-fp-abc123",
    );

    const universal = variantById(
      "android-tv-release-device-debugkey-universal",
    );
    expect(universal).toBeDefined();
    expect(artifactName(universal!, "def456")).toBe(
      "streamyfin-android-tv-release-device-debugkey-universal-r1-fp-def456",
    );
  });

  it("marks only the two universal Android release variants as universal", () => {
    const universalIds = VARIANTS.filter((v) => v.universal).map((v) => v.id);
    expect(universalIds).toEqual([
      "android-phone-release-device-debugkey-universal",
      "android-tv-release-device-debugkey-universal",
    ]);
  });

  it("assigns ipa, app, and apk kinds to the right variants", () => {
    const byKind = (kind: string) =>
      VARIANTS.filter((v) => v.kind === kind).length;
    expect(byKind("ipa")).toBe(3);
    expect(byKind("app")).toBe(4);
    expect(byKind("apk")).toBe(6);
  });

  it("separates repack (7d) and ensure (90d) retention policies", () => {
    for (const v of VARIANTS) {
      expect(v.retentionDays).toBe(v.mode === "repack" ? 7 : 90);
    }
  });

  it("assigns all four ABIs to Android ensure variants and trimmed ABIs to repack", () => {
    expect(variantById("android-phone-release-device-debugkey")?.abis).toEqual([
      "arm64-v8a",
    ]);
    expect(variantById("android-tv-release-device-debugkey")?.abis).toEqual([
      "arm64-v8a",
      "armeabi-v7a",
    ]);
    expect(
      variantById("android-phone-release-device-debugkey-universal")?.abis,
    ).toEqual(["arm64-v8a", "armeabi-v7a", "x86", "x86_64"]);
  });

  it("returns undefined for an unknown variant id", () => {
    expect(variantById("unknown-variant")).toBeUndefined();
  });
});
