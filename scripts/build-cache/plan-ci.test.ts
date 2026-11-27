import { planNativeBuilds } from "./plan-ci";
import { VARIANTS } from "./variants";

const repacks = VARIANTS.filter((variant) => variant.mode === "repack");
const repacked = Object.fromEntries(
  repacks.map((variant) => [variant.id, "success"]),
);
const plan = (
  overrides: Partial<Parameters<typeof planNativeBuilds>[0]> = {},
) =>
  planNativeBuilds({
    fingerprintResult: "success",
    fingerprintOutputs: {},
    repackResults: repacked,
    canSign: true,
    ...overrides,
  });

test("schedules no native runner when repacks and ensures hit", () => {
  expect(plan()).toEqual({ ios: {}, android: {} });
});

test("builds only selected variants, even when a repack fails", () => {
  expect(
    plan({
      repackResults: {
        ...repacked,
        "ios-tv-release-device-unsigned": "failure",
      },
      fingerprintOutputs: {
        ios_tv_release_device_unsigned_name: "tv-ipa",
        android_phone_debug_device_debugkey_build: "true",
        android_phone_debug_device_debugkey_name: "phone-apk",
        android_tv_debug_device_debugkey_build: "false",
      },
    }),
  ).toEqual({
    ios: {
      tv: true,
      variants: { "ios-tv-release-device-unsigned": { name: "tv-ipa" } },
    },
    android: {
      phone: true,
      variants: {
        "android-phone-debug-device-debugkey": { name: "phone-apk" },
      },
    },
  });
});

test("a failed fingerprint builds only repack variants without trusting any supplied name", () => {
  const result = plan({
    fingerprintResult: "failure",
    fingerprintOutputs: {
      ios_phone_release_device_unsigned_name: "bad",
      android_phone_debug_device_debugkey_build: "true",
    },
    repackResults: {},
  });
  for (const os of ["ios", "android"] as const) {
    expect(result[os]).toEqual({
      phone: true,
      tv: true,
      variants: Object.fromEntries(
        repacks
          .filter((variant) => variant.os === os)
          .map((variant) => [variant.id, { name: "" }]),
      ),
    });
  }
});

test("does not schedule a macOS build solely for unavailable signing credentials", () => {
  expect(
    plan({
      canSign: false,
      repackResults: {
        ...repacked,
        "ios-phone-release-device-signed": "skipped",
      },
    }),
  ).toEqual({ ios: {}, android: {} });
});
