import { type Os, VARIANTS } from "./variants";

type BuildGroup = Partial<{
  phone: true;
  tv: true;
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
}: PlanInputs): Record<Os, BuildGroup> => {
  const plan: Record<Os, BuildGroup> = { ios: {}, android: {} };
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

    const group = plan[variant.os];
    group[variant.form] = true;
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
  for (const [os, group] of Object.entries(plan)) {
    console.log(`${os}=${JSON.stringify(group)}`);
  }
}
