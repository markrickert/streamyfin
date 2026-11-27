/**
 * Single source of truth for native build cache variants and their GitHub
 * Actions artifact names.
 *
 * Artifact names follow:
 * `streamyfin-<os>-<form>-<config>-<target>-<signing>[-universal]-<recipe>-fp-<hash>`
 */

export type Os = "ios" | "android";
export type Form = "phone" | "tv";
export type BuildConfig = "debug" | "release";
export type Target = "device" | "simulator";
export type Signing = "signed" | "unsigned" | "debugkey";
export type BuildMode = "repack" | "ensure";
export type Runner = "macos" | "linux";
export type BinaryKind = "ipa" | "app" | "apk";
export type AndroidAbi = "arm64-v8a" | "armeabi-v7a" | "x86" | "x86_64";

const ALL_ANDROID_ABIS: readonly AndroidAbi[] = [
  "arm64-v8a",
  "armeabi-v7a",
  "x86",
  "x86_64",
];

export interface Variant {
  /** Stable identifier without recipe or fingerprint hash. */
  readonly id: string;
  readonly os: Os;
  readonly form: Form;
  readonly config: BuildConfig;
  readonly target: Target;
  readonly signing: Signing;
  readonly universal: boolean;
  /** Bump when the build recipe changes in a way `@expo/fingerprint` cannot see. */
  readonly recipe: string;
  readonly mode: BuildMode;
  readonly retentionDays: number;
  readonly runner: Runner;
  readonly kind: BinaryKind;
  readonly abis: readonly AndroidAbi[];
}

interface VariantSpec {
  readonly os: Os;
  readonly form: Form;
  readonly config: BuildConfig;
  readonly target: Target;
  readonly signing: Signing;
  readonly universal?: boolean;
  readonly recipe?: string;
  readonly mode: BuildMode;
  readonly retentionDays: number;
  readonly runner: Runner;
  readonly kind: BinaryKind;
  readonly abis?: readonly AndroidAbi[];
}

const makeVariantId = (spec: VariantSpec): string => {
  const parts: string[] = [
    spec.os,
    spec.form,
    spec.config,
    spec.target,
    spec.signing,
  ];
  if (spec.universal) parts.push("universal");
  return parts.join("-");
};

const defineVariant = (spec: VariantSpec): Variant => ({
  id: makeVariantId(spec),
  os: spec.os,
  form: spec.form,
  config: spec.config,
  target: spec.target,
  signing: spec.signing,
  universal: spec.universal ?? false,
  recipe: spec.recipe ?? "r1",
  mode: spec.mode,
  retentionDays: spec.retentionDays,
  runner: spec.runner,
  kind: spec.kind,
  abis: spec.abis ?? [],
});

export const VARIANTS: readonly Variant[] = [
  // Repacked on every run.
  defineVariant({
    os: "ios",
    form: "phone",
    config: "release",
    target: "device",
    signing: "signed",
    mode: "repack",
    retentionDays: 7,
    runner: "macos",
    kind: "ipa",
  }),
  defineVariant({
    os: "ios",
    form: "phone",
    config: "release",
    target: "device",
    signing: "unsigned",
    mode: "repack",
    retentionDays: 7,
    runner: "macos",
    kind: "ipa",
  }),
  defineVariant({
    os: "ios",
    form: "tv",
    config: "release",
    target: "device",
    signing: "unsigned",
    mode: "repack",
    retentionDays: 7,
    runner: "macos",
    kind: "ipa",
  }),
  defineVariant({
    os: "android",
    form: "phone",
    config: "release",
    target: "device",
    signing: "debugkey",
    mode: "repack",
    retentionDays: 7,
    runner: "linux",
    kind: "apk",
    abis: ["arm64-v8a"],
  }),
  defineVariant({
    os: "android",
    form: "tv",
    config: "release",
    target: "device",
    signing: "debugkey",
    mode: "repack",
    retentionDays: 7,
    runner: "linux",
    kind: "apk",
    abis: ["arm64-v8a", "armeabi-v7a"],
  }),

  // Ensure: built only when missing or near expiry.
  defineVariant({
    os: "ios",
    form: "phone",
    config: "debug",
    target: "simulator",
    signing: "unsigned",
    mode: "ensure",
    retentionDays: 90,
    runner: "macos",
    kind: "app",
  }),
  defineVariant({
    os: "ios",
    form: "tv",
    config: "debug",
    target: "simulator",
    signing: "unsigned",
    mode: "ensure",
    retentionDays: 90,
    runner: "macos",
    kind: "app",
  }),
  defineVariant({
    os: "android",
    form: "phone",
    config: "debug",
    target: "device",
    signing: "debugkey",
    mode: "ensure",
    retentionDays: 90,
    runner: "linux",
    kind: "apk",
    abis: ALL_ANDROID_ABIS,
  }),
  defineVariant({
    os: "android",
    form: "tv",
    config: "debug",
    target: "device",
    signing: "debugkey",
    mode: "ensure",
    retentionDays: 90,
    runner: "linux",
    kind: "apk",
    abis: ALL_ANDROID_ABIS,
  }),
  defineVariant({
    os: "ios",
    form: "phone",
    config: "release",
    target: "simulator",
    signing: "unsigned",
    mode: "ensure",
    retentionDays: 90,
    runner: "macos",
    kind: "app",
  }),
  defineVariant({
    os: "ios",
    form: "tv",
    config: "release",
    target: "simulator",
    signing: "unsigned",
    mode: "ensure",
    retentionDays: 90,
    runner: "macos",
    kind: "app",
  }),
  defineVariant({
    os: "android",
    form: "phone",
    config: "release",
    target: "device",
    signing: "debugkey",
    universal: true,
    mode: "ensure",
    retentionDays: 90,
    runner: "linux",
    kind: "apk",
    abis: ALL_ANDROID_ABIS,
  }),
  defineVariant({
    os: "android",
    form: "tv",
    config: "release",
    target: "device",
    signing: "debugkey",
    universal: true,
    mode: "ensure",
    retentionDays: 90,
    runner: "linux",
    kind: "apk",
    abis: ALL_ANDROID_ABIS,
  }),
];

const VARIANT_MAP = new Map<string, Variant>(
  VARIANTS.map((variant) => [variant.id, variant]),
);

/** Returns the artifact name for a variant and fingerprint hash. */
export const artifactName = (variant: Variant, hash: string): string =>
  `streamyfin-${variant.id}-${variant.recipe}-fp-${hash}`;

/** Looks up a variant by its id, or undefined when unknown. */
export const variantById = (id: string): Variant | undefined =>
  VARIANT_MAP.get(id);
