#!/usr/bin/env bash
# Runs one screenshot flow with the instance settings from the environment.
#
#   e2e/suites/screenshots/run.sh <flow name> <out dir> [device]
#
# All settings come from the shell environment — there is no .env file: the comparison
# runner snapshots this suite per ref and passes the variables itself, so a flow behaves
# identically across a git switch. The contract:
#
#   MAESTRO_JELLYFIN_URL   iOS/tvOS: http://127.0.0.1:<SYNCPLAY_PORT>
#                          Android:  http://10.0.2.2:<SYNCPLAY_PORT>
#   MAESTRO_JELLYFIN_USER  syncplay-host
#   MAESTRO_JELLYFIN_PASS  the fixture account password
#   MAESTRO_SEERR_URL      same host alias as above, <SYNCPLAY_SEERR_PORT>
#   MAESTRO_SEERR_PASS     same password as MAESTRO_JELLYFIN_PASS
#
# None of it is echoed: Maestro receives it as MAESTRO_* variables.
#
# Android phone AND TV: the plugin pushes Seerr as http://127.0.0.1:<SYNCPLAY_SEERR_PORT>
# for any client, which on an emulator is its own loopback — both platforms need
# `adb reverse tcp:<SYNCPLAY_SEERR_PORT> tcp:<SYNCPLAY_SEERR_PORT>` before the Seerr
# flows run. The runner reuses an identical mapping and refuses a conflicting one.
#
# Maestro runs from the bundled maestro.py the runner drops next to this script in the
# per-ref snapshot, so a checkout switch cannot change the driver under a running pass.
# Outside a snapshot it falls back to the repo copy for local runs.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"

flow="${1:?usage: run.sh <flow name> <out dir> [device]}"
out="${2:?usage: run.sh <flow name> <out dir> [device]}"
device="${3:-}"

case "$flow" in
  bootstrap-login-*) required=(MAESTRO_JELLYFIN_URL MAESTRO_JELLYFIN_USER MAESTRO_JELLYFIN_PASS) ;;
  bootstrap-seerr-mobile|ensure-seerr-mobile) required=(MAESTRO_SEERR_URL MAESTRO_SEERR_PASS) ;;
  *) required=() ;;
esac
for name in ${required[@]+"${required[@]}"}; do
  if [ -z "${!name:-}" ]; then
    echo "run.sh: $name is not set: the runner exports it (see the contract in this file)" >&2
    exit 2
  fi
done

maestro="$here/maestro.py"
[ -f "$maestro" ] || maestro="$repo/e2e/bench/maestro.py"

args=(--flow "$here/flows/$flow.yml" --out "$out")
[ -n "$device" ] && args+=(--device "$device")
# Exporting is not enough: maestro.py turns --env KEY=VALUE into Maestro's -e flags, so
# every MAESTRO_* variable in the shell is forwarded as an argument. Values ride argv to
# python only — nothing is echoed, and maestro.py masks -e values when it logs.
for name in $(compgen -v 'MAESTRO_'); do
  args+=(--env "${name}=${!name}")
done
exec python3 "$maestro" "${args[@]}"
