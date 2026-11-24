#!/usr/bin/env bash
# Resolve BEFORE_REF and AFTER_REF for the CI screenshot workflow and write them
# to $GITHUB_ENV.
set -euo pipefail

: "${GITHUB_ENV:?GITHUB_ENV must be set}"

resolve_ref() {
  local ref="$1"
  if git rev-parse --verify "${ref}^{commit}" >/dev/null 2>&1; then
    echo "$ref"
    return 0
  fi
  if git rev-parse --verify "origin/${ref}^{commit}" >/dev/null 2>&1; then
    echo "origin/${ref}"
    return 0
  fi
  git fetch --no-tags origin "${ref#origin/}:refs/remotes/origin/${ref#origin/}" >/dev/null 2>&1 ||
    git fetch --no-tags origin "$ref" >/dev/null 2>&1 || true
  if git rev-parse --verify "${ref}^{commit}" >/dev/null 2>&1; then
    echo "$ref"
    return 0
  fi
  if git rev-parse --verify "origin/${ref}^{commit}" >/dev/null 2>&1; then
    echo "origin/${ref}"
    return 0
  fi
  echo "::error::Could not resolve ref '$ref' locally" >&2
  return 1
}

if [ "${EVENT_NAME:-}" = "pull_request" ]; then
  raw_before="origin/${PR_BASE_REF:?PR_BASE_REF must be set for pull_request}"
  raw_after="${PR_HEAD_SHA:?PR_HEAD_SHA must be set for pull_request}"
else
  raw_before="${INPUT_BEFORE:?INPUT_BEFORE must be set}"
  raw_after="${INPUT_AFTER:-${DISPATCH_SHA:?DISPATCH_SHA must be set when INPUT_AFTER is empty}}"
fi

before_ref="$(resolve_ref "$raw_before")"
after_ref="$(resolve_ref "$raw_after")"
{
  echo "BEFORE_REF=$before_ref"
  echo "AFTER_REF=$after_ref"
} >> "$GITHUB_ENV"
