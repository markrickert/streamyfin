#!/usr/bin/env bash
# One-time iOS simulator setup: turns Password AutoFill off. With it on, the simulator
# draws an "Automatic Strong Password cover view" over every secure text field, the
# keyboard never opens, and a flow cannot type a password. It changes the simulator, not
# the app.
#
#   ios-disable-autofill.sh [simulator udid]    (defaults to the booted iPhone)
#
# This writes the same restrictedBool.allowPasswordAutoFill value the Settings toggle
# writes, in the three plists that carry it — the Settings UI offers no stable selector
# for the switch (its a11y label is the row title, shared with the row's static text), so
# the write is done directly instead of driving the UI. Prints the resulting value so the
# caller can assert it took. Run while the simulator is booted and past first-boot settle.
set -euo pipefail

udid="${1:-$(xcrun simctl list devices booted | grep -v 'Apple TV\|Apple Watch\|Vision' | sed -nE 's/.*\(([0-9A-F-]{36})\).*/\1/p' | head -1)}"
[ -n "$udid" ] || { echo "ios-disable-autofill.sh: no booted iOS simulator (pass a udid)" >&2; exit 2; }

dev="$HOME/Library/Developer/CoreSimulator/Devices/$udid/data"
files=(
  "$dev/Containers/Shared/SystemGroup/systemgroup.com.apple.configurationprofiles/Library/ConfigurationProfiles/UserSettings.plist"
  "$dev/Library/UserConfigurationProfiles/EffectiveUserSettings.plist"
  "$dev/Library/UserConfigurationProfiles/PublicInfo/PublicEffectiveUserSettings.plist"
)
for f in "${files[@]}"; do
  [ -f "$f" ] || { echo "ios-disable-autofill.sh: missing $f" >&2; exit 1; }
  plutil -replace restrictedBool.allowPasswordAutoFill.value -bool NO "$f"
done

result="$(plutil -extract restrictedBool.allowPasswordAutoFill.value raw "${files[0]}")"
echo "ios-disable-autofill.sh: $udid allowPasswordAutoFill=$result"
[ "$result" = "0" ] || [ "$result" = "false" ]
