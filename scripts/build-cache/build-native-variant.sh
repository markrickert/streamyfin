#!/usr/bin/env bash
set -eo pipefail

# Read variant metadata directly from variants.ts so ABIs and build
# flags stay in one place.
vars=$(bun -e '
  import { variantById } from "./scripts/build-cache/variants.ts";
  const v = variantById(process.argv[1]);
  if (!v) process.exit(1);
  for (const [k, val] of [
    ["v_os", v.os],
    ["v_form", v.form],
    ["v_config", v.config],
    ["v_target", v.target],
    ["v_signing", v.signing],
    ["v_abis", v.abis.join(",")],
  ]) console.log(`${k}=${JSON.stringify(val)}`);
' "$VARIANT") || { echo "::error::Could not read variant $VARIANT from variants.ts"; exit 1; }
eval "$vars"
[ -n "$v_os" ] || { echo "::error::Unknown variant $VARIANT"; exit 1; }

if [ "$v_form" = "tv" ]; then
  export EXPO_TV=1
elif [ "$v_form" = "phone" ]; then
  export EXPO_TV=0
else
  echo "::error::No build recipe for $VARIANT"
  exit 1
fi

# Simulator .app bundles contain symlinks and file modes that upload-artifact's
# zip flattens unless wrapped in a tar first.
build_ios_simulator() {
  local xc_config="$1"
  local sdk
  if [ "$v_form" = "tv" ]; then
    sdk="appletvsimulator"
  elif [ "$v_form" = "phone" ]; then
    sdk="iphonesimulator"
  else
    echo "::error::No build recipe for $VARIANT"
    exit 1
  fi

  shopt -s nullglob
  workspaces=(ios/*.xcworkspace)
  [ "${#workspaces[@]}" -eq 1 ] || {
    echo "::error::Expected one .xcworkspace under ios/, found ${#workspaces[@]}"
    exit 1
  }
  workspace="${workspaces[0]}"
  scheme=$(basename "$workspace" .xcworkspace)
  derived="$RUNNER_TEMP/native-$v_form/DerivedData"
  extra_args=()
  if [ "$xc_config" = "Release" ]; then
    # Simulator Release builds need no Apple cert or provisioning profile.
    extra_args+=(CODE_SIGNING_ALLOWED=NO)
  fi

  # Compile only the host arm64 slice: the x86_64 half of a universal
  # simulator build doubles compile time and no CI consumer is Intel.
  xcodebuild \
    -workspace "$workspace" \
    -scheme "$scheme" \
    -configuration "$xc_config" \
    -sdk "$sdk" \
    -derivedDataPath "$derived" \
    ARCHS=arm64 \
    ONLY_ACTIVE_ARCH=YES \
    "${extra_args[@]}" \
    build

  products="$derived/Build/Products/${xc_config}-${sdk}"
  apps=("$products"/*.app)
  [ "${#apps[@]}" -eq 1 ] || {
    echo "::error::Expected one .app under $products, found ${#apps[@]}"
    exit 1
  }
  app_name=$(basename "${apps[0]}")
  tar_path="$artifact_dir/${ARTIFACT_NAME}.tar"
  # COPYFILE_DISABLE=1 stops macOS tar from adding AppleDouble (._*) files.
  COPYFILE_DISABLE=1 tar -cf "$tar_path" -C "$products" "$app_name"
  echo "artifact_path=$tar_path" >> "$GITHUB_OUTPUT"
}

# Each variant uploads from its own directory before the next build can
# overwrite the Gradle output or replace the generated project.
artifact_dir="$GITHUB_WORKSPACE/build/native-$v_form/$VARIANT"
mkdir -p "$artifact_dir"

if [ "$v_os" = "android" ]; then
  # Stop the Gradle daemon when each variant exits so the next variant on the
  # same runner starts with a clean heap while keeping on-disk build outputs.
  trap '[ -x android/gradlew ] && (cd android && ./gradlew --stop) || true' EXIT
fi

if [ "$v_os" = "android" ] && [ "$v_config" = "debug" ] && [ "$v_target" = "device" ]; then
  export ORG_GRADLE_PROJECT_reactNativeArchitectures="$v_abis"
  (cd android && ./gradlew assembleDebug)
  cp android/app/build/outputs/apk/debug/app-debug.apk "$artifact_dir/"
  echo "artifact_path=$artifact_dir/app-debug.apk" >> "$GITHUB_OUTPUT"
elif [ "$v_os" = "android" ] && [ "$v_config" = "release" ] && [ "$v_target" = "device" ]; then
  export ORG_GRADLE_PROJECT_reactNativeArchitectures="$v_abis"
  # Keep R8 minification and resource shrinking enabled for release APKs.
  bun run build:android:local
  cp android/app/build/outputs/apk/release/app-release.apk "$artifact_dir/"
  echo "artifact_path=$artifact_dir/app-release.apk" >> "$GITHUB_OUTPUT"
elif [ "$v_os" = "ios" ] && [ "$v_config" = "release" ] && [ "$v_target" = "device" ]; then
  if [ "$v_signing" = "signed" ] && [ "$v_form" = "phone" ]; then
    # `ci` profile (extends production, autoIncrement off): keeps CI builds out
    # of the production version tier and stops them inflating the store counter.
    eas build -p ios --local --non-interactive --profile ci --output "$artifact_dir/Streamyfin.ipa"
    echo "artifact_path=$artifact_dir/Streamyfin.ipa" >> "$GITHUB_OUTPUT"
  elif [ "$v_signing" = "unsigned" ]; then
    bun scripts/ios/build-ios.ts --production --no-install --output "$artifact_dir/Streamyfin.ipa"
    echo "artifact_path=$artifact_dir/Streamyfin.ipa" >> "$GITHUB_OUTPUT"
  else
    echo "::error::No build recipe for $VARIANT"
    exit 1
  fi
elif [ "$v_os" = "ios" ] && [ "$v_config" = "release" ] && [ "$v_target" = "simulator" ]; then
  export NODE_ENV=production
  build_ios_simulator Release
elif [ "$v_os" = "ios" ] && [ "$v_config" = "debug" ] && [ "$v_target" = "simulator" ]; then
  build_ios_simulator Debug
else
  echo "::error::No build recipe for $VARIANT"
  exit 1
fi
