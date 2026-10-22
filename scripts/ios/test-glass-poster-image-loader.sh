#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
test_dir=$(mktemp -d "${TMPDIR:-/tmp}/streamyfin-glass-poster.XXXXXX")
trap 'rm -r "$test_dir"' EXIT
swiftc -module-cache-path "$test_dir/modules" \
  modules/glass-poster/ios/GlassPosterImageLoader.swift tests/native/GlassPosterImageLoaderTests.swift \
  -o "$test_dir/test"
"$test_dir/test"
