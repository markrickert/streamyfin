# Screenshot comparison suite

Compares two refs screen-for-screen on a development client: the runner switches this
checkout between the refs, serves each with its own Metro, captures the same shots three
times — before, a fresh "noise" pass on the before build, after — and scores them with
`compare.ts`, which judges a change only when it beats the run's own noise floor.
The runner uses local debug clients, never CI release artifacts: it needs a simulator or
emulator, Java for Maestro, and the SyncPlay fixture on either backend, Docker or native
(`SYNCPLAY_BACKEND=native`, see `e2e/suites/syncplay/README.md`). All four platforms
(`ios`, `apple-tv`, `android`, `android-tv`) run locally and on demand in
`.github/workflows/e2e-screenshots.yml`.

## CI

`.github/workflows/e2e-screenshots.yml` runs on demand (never on `push`, `synchronize`,
or `schedule`):

- Apply the `run-screenshots` label to a pull request targeting `develop` or `master` to
  run all four platforms (`origin/<base_ref>` against the PR head SHA; remove and re-add
  the label to rerun).
- Dispatch manually (`workflow_dispatch`) with `before` (required ref), optional `after`
  (defaults to the dispatched ref), and `platforms` (comma-separated subset of
  `ios,apple-tv,android,android-tv`, defaulting to all four).

The `plan` job on `ubuntu-26.04` validates `platforms` and emits separate `apple` and
`android` matrices, skipping either job when its list is empty:

- **`ios` and `apple-tv` (`apple` job on `macos-latest`)**: uses the newest Xcode,
  `SYNCPLAY_BACKEND=native`, and a fresh simulator. Apple silicon runners lack nested
  virtualization, so they cannot run Docker or an Android emulator. `ios` runs
  `ios-disable-autofill.sh` after boot; `apple-tv` does not.
- **`android` and `android-tv` (`android` job on `ubuntu-26.04`)**: uses KVM, the
  Docker fixture, and `reactivecircus/android-emulator-runner` on API 34 `x86_64`
  (`google_apis` for `android`; `android-tv` with profile `tv_1080p` for `android-tv`).
  Teardown runs `e2e:down` under `always()`, falling back to `sudo rm -rf` on
  `e2e/suites/syncplay/.state` if Linux Docker wrote root-owned files there.

Each platform uses its own `build-cache` cache prefix, pruned to the newest four entries.
Jobs fail only on runner, build, or capture errors (including blank screenshots). Changed
screens go to `$GITHUB_STEP_SUMMARY` (`summary.md`) and upload as
`e2e-screenshots-<platform>-report` alongside `e2e-screenshots-<platform>-fixture-logs`.

## Commands

```sh
bun run e2e:shots:doctor [--fix] [--platform ios|android|android-tv|apple-tv]
bun run e2e:shots --platform <p> [--before <ref>] [--after <ref>] [--device <id>] [--out <dir>] [--port <port>]
```

`--before` defaults to the base the Reassure baseline measures against
(`resolveBaseRef` in `scripts/reassure-baseline.ts`): the PR target, else `develop`, on
`upstream` before `origin`. A stacked branch should pass its parent. `--after` defaults
to `HEAD`.

`doctor` reports tree cleanliness, fixture reachability, and whether the pinned Maestro
is installed. It is read-only unless you pass `--fix`. `--fix` brings up an unhealthy
fixture the way `run` does (step 2 below) and installs the pinned Maestro. It never
touches a dirty tree: commit or stash yourself.
`run` refuses a dirty tree, identical refs, a physical device, or a busy port, then:

**Device use**: point the runner at an emulator or simulator kept for screenshots. Each
run installs over any copy of the app with the built app's exact id, and every capture
pass clears that app's data, so a copy you sign in to on the same device loses its data.
On Android a copy signed with another key is uninstalled and installed again. On iOS
the per-pass reset uninstalls and reinstalls only the built app, never the whole
simulator. Physical devices are refused. A phone run freezes the status bar at 12:00
with full signal and battery, and puts it back when it ends: System UI demo mode on
Android (which also hides notification icons), `simctl status_bar` on iOS. On Android
every run also turns stylus handwriting off.

1. Snapshots the suite's tooling (flows, run.sh, compare.ts, masks, `e2e/bench/maestro.py`)
   into `e2e/reports/shots/<session>/tooling`, so the checked-out ref cannot change the
   tools mid-run. The runner itself is loaded before the first switch and is not copied.
   `e2e/reports/` is gitignored.
2. Brings up the local fixture: `bun run e2e:setup`, `e2e:seed`, `e2e:enrich`, then Seerr
   catalog enablement + plugin provisioning via `suites.syncplay.seerr`. It never runs
   `e2e:down` — the fixture stays up afterwards.
3. For the before ref, then the after ref: `git switch --detach` (never `--force`),
   `bun install --frozen-lockfile` when the lockfile changed, `@expo/fingerprint` with the
   platform's `EXPO_TV` (same recipe as `.github/workflows/build-apps.yml`), reuse of the
   cached debug client in `e2e/reports/shots/build-cache/<platform>/<hash>` or a local
   debug build (`./gradlew assembleDebug` / `xcodebuild … Debug`), install on the chosen
   simulator/emulator, a runner-owned `expo start --dev-client --clear` on a port it proved
   free first, then each capture pass as one parent Maestro invocation with `--env`
   forwarded by `run.sh`.
4. `compare.ts --before … --noise … --after …` with the platform masks; the report and
   changed-screen evidence land in the session directory.

On success, failure, or Ctrl-C the runner stops only its own Metro, switches back to the
starting branch or detached SHA (never forcing), reinstalls its dependencies when the last
ref's lockfile differs, and restores `ios/`/`android/` from the session backup: a clean
prebuild only happens on a cache miss, and the user's native dirs are moved aside first,
never deleted.

## Environment contract (flows)

The runner exports these per platform; `run.sh` forwards every `MAESTRO_*` as `--env`
arguments to `maestro.py`, which masks them when it echoes its command line.

| Variable | ios / apple-tv | android / android-tv |
| --- | --- | --- |
| `MAESTRO_APP_ID` | the built app's bundle id | the built APK's applicationId (`.debug` on current refs, may be unsuffixed on older ones) |
| `MAESTRO_DEV_CLIENT_URL` | the dev-client deep link to `http://127.0.0.1:<port>` | the dev-client deep link to `http://10.0.2.2:<port>` |
| `MAESTRO_JELLYFIN_URL` | `http://127.0.0.1:<SYNCPLAY_PORT>` | `http://10.0.2.2:<SYNCPLAY_PORT>` |
| `MAESTRO_JELLYFIN_USER` | `syncplay-host` | same |
| `MAESTRO_JELLYFIN_PASS` | the fixture password | same |
| `MAESTRO_SEERR_URL` | `http://127.0.0.1:<SYNCPLAY_SEERR_PORT>` | `http://10.0.2.2:<SYNCPLAY_SEERR_PORT>` |
| `MAESTRO_SEERR_PASS` | the fixture password | same |

Each before/noise/after pass is one parent flow — `pass-mobile.yml` or `pass-tv.yml` —
that runs the platform's flows in a fixed order: `bootstrap-login-*`, `mobile|tv`, the
Seerr bootstrap (`ensure-seerr-mobile` connects only when Discover is missing;
`bootstrap-seerr-tv` verifies the plugin-pushed sign-in), then `seerr-*`. Order is
load-bearing: the login must come first on the freshly-reset app and the Seerr screens
only exist once connected, so state is reset between passes, never inside one. Apple TV
shares the `tv` flows and branches on `MAESTRO_TVOS`.

Screenshot names are the pairing key for compare.ts — `00-login`, `00-login-connected`,
`00-intro` (phones only: `Home.tv.tsx` never presents the sheet), `01`–`09` for app
screens, `10`–`12` for Seerr with `13-seerr-settings` on phones (captured by
`ensure-seerr-mobile.yml` on either connection path), `14-library-filter-sheet`
and `15-series-details` on phones, `08-library-filters` and `09-series-details` on TV.
`10-seerr-discover` is scored informational: its TMDB feed is live data. Item pages are
opened read-only and nothing plays anywhere: on TV a card press can start playback, so
only routes that push a detail page are tapped.

## Every platform uses the pinned Maestro

Upstream Maestro hangs on tvOS (mobile-dev-inc/Maestro PR #3021 is unmerged), so every
platform runs the pinned `plexinc/Maestro` fork `cli-2.8.0.6`, one driver for all four.
It is downloaded once into `e2e/reports/shots/tools/<tag>/`, sha256-verified (see
`MAESTRO_TAG` and `MAESTRO_SHA256` in `lib/tooling.ts`), and passed to `maestro.py
--maestro <binary>`. Apple TV adds `--platform tvos`. The cache is keyed by tag, so
bumping the pin makes `doctor` report the new one missing until `--fix` or the next `run`
installs it. The user's global `maestro` is never used or touched, and there is no
AppleScript/DeviceHub fallback.

## Seerr on TV

TV builds have no Seerr settings screen. `seerr.provision_client_access` pushes
`jellyseerrServerUrl` + `jellyseerrApiKey` into the Streamyfin plugin's config, so TV
clients sign in at Jellyfin login without a password. The pushed URL is `127.0.0.1` for
every client, so on Android — phone AND TV — the runner adds
`adb reverse tcp:<seerr-port>` to reach the host fixture, reuses an identical mapping,
and refuses a conflicting existing one. Phones also keep `bootstrap-seerr-mobile.yml`
(local settings UI) for refs without plugin-driven sign-in.

## iOS simulator one-time setup

`ios-disable-autofill.sh [udid]` turns Password AutoFill off by writing the same
`restrictedBool.allowPasswordAutoFill` value the Settings toggle writes (the switch has
no stable selector for a flow). Run it once per simulator, while it is booted.

## Operational constraints

- `e2e:enrich` must exit 0 before screenshots run; `run` treats a non-zero enrich as
  fatal.
- Flows prefer the screenshot `testID`s (`more-tab`, `seerr-poster-*`,
  `seerr-server-url`, `intro-done`) and use text/index fallbacks for refs without them.
  Those fallbacks are less precise; no flow uses coordinate taps.
- The fixture's Jellyfin and Seerr are shared, running services: the runner reuses them,
  never tears them down, and refuses foreign containers via the SyncPlay ownership checks.
