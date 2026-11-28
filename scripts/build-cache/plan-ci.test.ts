import { BUILD_GROUP_IDS, groupForVariant, planNativeBuilds } from "./plan-ci";
import { VARIANTS } from "./variants";

const emptyPlan = Object.fromEntries(BUILD_GROUP_IDS.map((id) => [id, {}]));
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
  expect(plan()).toEqual(emptyPlan);
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
        ios_phone_debug_simulator_unsigned_build: "true",
        ios_phone_debug_simulator_unsigned_name: "sim-app",
        android_phone_debug_device_debugkey_build: "true",
        android_phone_debug_device_debugkey_name: "phone-apk",
        android_tv_debug_device_debugkey_build: "true",
        android_tv_debug_device_debugkey_name: "tv-apk",
      },
    }),
  ).toEqual({
    ...emptyPlan,
    ios_tv_device: {
      variants: { "ios-tv-release-device-unsigned": { name: "tv-ipa" } },
    },
    ios_phone_sim: {
      variants: { "ios-phone-debug-simulator-unsigned": { name: "sim-app" } },
    },
    android_phone: {
      variants: {
        "android-phone-debug-device-debugkey": { name: "phone-apk" },
      },
    },
    android_tv: {
      variants: {
        "android-tv-debug-device-debugkey": { name: "tv-apk" },
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
  for (const groupId of BUILD_GROUP_IDS) {
    expect(result[groupId]).toEqual({
      variants: Object.fromEntries(
        repacks
          .filter((variant) => groupForVariant(variant) === groupId)
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
  ).toEqual(emptyPlan);
});
