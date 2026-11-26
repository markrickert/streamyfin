/**
 * Repack driver the screenshot runner shells out to:
 *
 *   bun <tooling>/repack/e2e/suites/screenshots/repack-runner.ts \
 *     --project <repo> --source <base apk> --output <apk> \
 *     --work <dir> --build-tools <dir>
 *
 * It runs from a copy inside the session tooling, not from the checkout: the ref
 * switch replaces node_modules and the `before` ref may predate @expo/repack-app.
 * The copy keeps the repo's relative layout, so the repack-android import below
 * resolves to the tooling copy of scripts/ci/repack-android.ts, which in turn
 * resolves @expo/repack-app from the tooling's own install. cwd is the checkout,
 * so export:embed runs with the switched ref's expo, Babel and Hermes.
 */
import { type Options, repackAppAndroidAsync } from "@expo/repack-app";
import {
  spawnProcess,
  withDeclaredAttributes,
} from "../../../scripts/ci/repack-android";

/**
 * Everything a repack needs except the spawn wrapper main() adds: jsBundleOnly
 * keeps the native base's manifest and app.config (the version row stays whatever
 * the base was built with), and exportEmbedOptions always re-embeds the JS even
 * when the source APK already carries a bundle.
 */
export function repackOptions(paths: {
  projectRoot: string;
  sourceAppPath: string;
  outputPath: string;
  workingDirectory: string;
  androidBuildToolsDir: string;
}): Options {
  return {
    platform: "android",
    jsBundleOnly: true,
    exportEmbedOptions: {},
    ...paths,
  };
}

const flag = (argv: string[], name: string): string => {
  const value = argv[argv.indexOf(`--${name}`) + 1];
  if (!value) throw new Error(`--${name} is required`);
  return value;
};

const main = async () => {
  const argv = process.argv.slice(2);
  const outputPath = flag(argv, "output");
  await repackAppAndroidAsync({
    ...repackOptions({
      projectRoot: flag(argv, "project"),
      sourceAppPath: flag(argv, "source"),
      outputPath,
      workingDirectory: flag(argv, "work"),
      androidBuildToolsDir: flag(argv, "build-tools"),
    }),
    spawnAsync: withDeclaredAttributes(spawnProcess),
  });
  console.log(`Repacked APK written to ${outputPath}`);
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
