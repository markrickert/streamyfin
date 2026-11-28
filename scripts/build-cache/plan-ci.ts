import { VARIANTS, type Variant } from "./variants";

export type BuildGroupId =
  | "android_phone"
  | "android_tv"
  | "ios_phone_device"
  | "ios_tv_device"
  | "ios_phone_sim"
  | "ios_tv_sim";

export const BUILD_GROUP_IDS: readonly BuildGroupId[] = [
  "android_phone",
  "android_tv",
  "ios_phone_device",
  "ios_tv_device",
  "ios_phone_sim",
  "ios_tv_sim",
];

export const groupForVariant = (variant: Variant): BuildGroupId => {
  if (variant.os === "android") {
    return variant.form === "phone" ? "android_phone" : "android_tv";
  }
  const target = variant.target === "device" ? "device" : "sim";
  return `ios_${variant.form}_${target}` as BuildGroupId;
};

type BuildGroup = Partial<{
  variants: Record<string, { name: string }>;
}>;

interface PlanInputs {
  fingerprintResult: string;
  fingerprintOutputs: Record<string, string>;
  repackResults: Record<string, string | undefined>;
  canSign: boolean;
}

export const planNativeBuilds = ({
  fingerprintResult,
  fingerprintOutputs,
  repackResults,
  canSign,
}: PlanInputs): Record<BuildGroupId, BuildGroup> => {
  const plan = Object.fromEntries(
    BUILD_GROUP_IDS.map((groupId) => [groupId, {}]),
  ) as Record<BuildGroupId, BuildGroup>;
  if (fingerprintResult === "skipped") return plan;
  const hashed = fingerprintResult === "success";
  for (const variant of VARIANTS) {
    if (variant.signing === "signed" && !canSign) continue;
    const key = variant.id.replaceAll("-", "_");
    const shouldBuild =
      variant.mode === "repack"
        ? repackResults[variant.id] !== "success"
        : hashed && fingerprintOutputs[`${key}_build`] === "true";
    if (!shouldBuild) continue;

    const group = plan[groupForVariant(variant)];
    group.variants ??= {};
    group.variants[variant.id] = {
      name: hashed ? (fingerprintOutputs[`${key}_name`] ?? "") : "",
    };
  }
  return plan;
};

if (require.main === module) {
  const plan = planNativeBuilds({
    fingerprintResult: process.env.FINGERPRINT_RESULT ?? "",
    fingerprintOutputs: JSON.parse(process.env.FINGERPRINT_OUTPUTS ?? "{}"),
    repackResults: Object.fromEntries(
      VARIANTS.filter((variant) => variant.mode === "repack").map((variant) => [
        variant.id,
        process.env[`REPACK_${variant.id.replaceAll("-", "_").toUpperCase()}`],
      ]),
    ),
    canSign: process.env.CAN_SIGN === "true",
  });
  for (const [groupId, group] of Object.entries(plan)) {
    console.log(`${groupId}=${JSON.stringify(group)}`);
  }
}
