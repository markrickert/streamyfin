# Screenshot comparison suite

Compares two refs screen-for-screen on a development client. The runner switches this
checkout between the refs, serves each with its own Metro, captures the same shots three
times (before, a fresh "noise" pass on the before build, and after), and scores them with
`compare.ts`. A change counts only when it beats the run's own noise floor.

The runner uses local debug clients, never CI release artifacts. It needs a simulator or
emulator, Java for Maestro, and the SyncPlay fixture on either backend, Docker or native
(`SYNCPLAY_BACKEND=native`, see `e2e/suites/syncplay/README.md`). All four platforms
(`ios`, `apple-tv`, `android`, `android-tv`) run locally, on every push to `develop`, and
on demand in `.github/workflows/e2e-screenshots.yml`.

## CI

`.github/workflows/e2e-screenshots.yml` runs on:

- **Every push to `develop`**: previous tip (`github.event.before`) against the pushed
  commit, all four platforms. Later pushes never cancel earlier runs. Android TV's
  `tv-nav-*` IDs must exist on the previous tip; other screenshot IDs have fallbacks.
- **A PR labeled `run-screenshots`** (target `develop` or `master`): `origin/<base_ref>`
  against the PR head. Remove and re-add the label to rerun.
- **`workflow_dispatch`**: `before` (required), `after` (default: dispatched ref), and
  `platforms` (subset of `ios,apple-tv,android,android-tv`, default all).

The `plan` job validates `platforms` and skips a job whose matrix is empty.

- `ios`, `apple-tv` run on `xcode-27` with the native fixture. Apple silicon runners
  cannot run Docker or an Android emulator. Only `ios` runs `ios-disable-autofill.sh`.
- `android`, `android-tv` run on `ubuntu-26.04` with KVM, the Docker fixture and
  `reactivecircus/android-emulator-runner` (API 34 `x86_64`; `tv_1080p` for TV). Teardown
  falls back to `sudo rm -rf` on `e2e/suites/syncplay/.state` for root-owned Docker files.

Dev clients are shared as artifacts named `shots-dev-client-<platform>-<hash>` (a tar, to
keep `.app` permissions and symlinks) and expire after 30 days. The fetch hook accepts only
artifacts whose `workflow_run.head_repository_id` is this repository, and only trusted runs
upload (pushes to `develop`, same-repository PRs, `workflow_dispatch`), so a fork PR cannot
plant a binary under another run's fingerprint.

Jobs fail only on runner, build or capture errors, blank screenshots included. Changed
screens go to `$GITHUB_STEP_SUMMARY` and upload as `e2e-screenshots-<platform>-report`
next to `e2e-screenshots-<platform>-fixture-logs`.

## Commands

```sh
bun run e2e:shots:doctor [--fix] [--platform ios|android|android-tv|apple-tv]
bun run e2e:shots --platform <p> [--before <ref>] [--after <ref>] [--device <id>] [--out <dir>] [--port <port>]
```

`--before` defaults to the base the Reassure baseline measures against (`resolveBaseRef`
in `scripts/reassure-baseline.ts`): the PR target, else `develop`, on `upstream` before
`origin`. A stacked branch should pass its parent. `--after` defaults to `HEAD`.

`doctor` reports tree cleanliness, fixture reachability, and whether the pinned Maestro is
installed. It is read-only unless you pass `--fix`, which brings up an unhealthy fixture
the way `run` does (step 2) and installs the pinned Maestro. It never touches a dirty
tree.

`run` refuses a dirty tree, identical refs, a physical device or a busy port, then:

1. Snapshots the tooling (flows, `run.sh`, `compare.ts`, masks, `e2e/bench/maestro.py`)
   into the gitignored `e2e/reports/shots/<session>/tooling`, so the checked-out ref cannot
   change it mid-run.
2. Brings up the fixture (`e2e:setup`, `e2e:seed`, `e2e:enrich`) and provisions Seerr via
   `suites.syncplay.seerr`. It never runs `e2e:down`.
3. For each ref: `git switch --detach` (never `--force`), `bun install --frozen-lockfile`
   if the lockfile changed, `@expo/fingerprint` with the platform's `EXPO_TV` (the recipe
   of `.github/workflows/build-apps.yml`), then the debug client from the local cache
   `e2e/reports/shots/build-cache/<platform>/<hash>`, else `SHOTS_BUILD_CACHE_FETCH`
   (`<exe> <platform> <hash> <cacheDir>`), else a local build. Each ref's
   `{ ref, platform, hash, source, path }` goes to `<session>/build-cache.json`. Then it
   installs the client, starts its own `expo start --dev-client --clear` on a free port,
   and runs each pass as one parent Maestro invocation.
4. Runs `compare.ts --before … --noise … --after …` with the platform masks. The report
   and changed-screen evidence land in the session directory.

`<hash>` is `<fingerprint>-<recipe>`. Bump `DEV_CLIENT_RECIPE` in `lib/build.ts` when a
runner change alters the native output, which the fingerprint cannot see. On Android the
hash also carries the emulator's first ABI (`ro.product.cpu.abilist`), which is passed to
Gradle as `-PreactNativeArchitectures`.

On success, failure or Ctrl-C the runner stops only its own Metro, returns to the starting
branch or SHA, reinstalls dependencies if the lockfile differs, and restores `ios/` and
`android/` from the session backup. Your native dirs are moved aside, never deleted.

### Device use

Use an emulator or simulator kept for screenshots. Each run installs over any app with the
built app's id, and each pass clears that app's data, so a copy you sign in to there loses
its data. On Android a copy signed with another key is uninstalled first. On iOS only the
built app is reinstalled. Physical devices are refused.

For the run the runner sets, then restores, a fixed status bar (Android demo mode, iOS
`simctl status_bar`; the iOS bar is also masked), disables Android animation scales and
stylus handwriting, and enables iOS Reduce Motion. Android navigation bars are masked at
the bottom of phone captures. Phone search input bands are masked to hide the caret. The
Android flows check that the tab bar is visible after the keyboard closes, and a covered
bar fails the pass. Masks do not cover the rest of a keyboard. Blank frames fail before
masks apply. A persisted baseline recipe must include `lib/device.ts` with the flows and
masks, because a change to these settings invalidates prior captures.

## Environment contract (flows)

The runner exports these per platform. `run.sh` forwards every `MAESTRO_*` as `--env` to
`maestro.py`, which masks them when it echoes its command line.

| Variable | ios / apple-tv | android / android-tv |
| --- | --- | --- |
| `MAESTRO_APP_ID` | the built app's bundle id | the built APK's applicationId (`.debug` on current refs, may be unsuffixed on older ones) |
| `MAESTRO_DEV_CLIENT_URL` | the dev-client deep link to `http://127.0.0.1:<port>` | the dev-client deep link to `http://10.0.2.2:<port>` |
| `MAESTRO_JELLYFIN_URL` | `http://127.0.0.1:<SYNCPLAY_PORT>` | `http://10.0.2.2:<SYNCPLAY_PORT>` |
| `MAESTRO_JELLYFIN_USER` | `syncplay-host` | same |
| `MAESTRO_JELLYFIN_PASS` | the fixture password | same |
| `MAESTRO_SEERR_URL` | `http://127.0.0.1:<SYNCPLAY_SEERR_PORT>` | `http://10.0.2.2:<SYNCPLAY_SEERR_PORT>` |
| `MAESTRO_SEERR_PASS` | the fixture password | same |

Each before, noise and after pass is one parent flow, `pass-mobile.yml` or `pass-tv.yml`,
that runs the platform's flows in a fixed order: `bootstrap-login-*`, `mobile|tv`, the
Seerr bootstrap, then `seerr-*`. The Seerr bootstrap is `ensure-seerr-mobile` (connects
only when Discover is missing) or `bootstrap-seerr-tv` (verifies the plugin-pushed
sign-in). The order is load-bearing: login must come first on the freshly reset app, and
the Seerr screens exist only once connected. State resets between passes, never inside
one. Apple TV and Android TV share one D-pad-driven flow set (`bootstrap-login-tv.yml`,
`tv.yml`, `bootstrap-seerr-tv.yml`, `seerr-tv.yml`) and gate platform-specific steps on
`MAESTRO_TVOS`.

Screenshot names are the pairing key for `compare.ts`:

- `00-login`, `00-login-connected`, and `00-intro` (phones only: `Home.tv.tsx` never
  presents the sheet).
- `01` to `09` for app screens.
- `10` to `12` for Seerr, plus `13-seerr-settings` on phones (captured by
  `ensure-seerr-mobile.yml` on either connection path).
- `14-library-filter-sheet` and `15-series-details` on phones, `08-library-filters` and
  `09-series-details` on TV.

`10-seerr-discover` is scored informational because its TMDB feed is live data. Item
pages are opened read-only and nothing plays: on TV a card press can start playback, so
flows tap only routes that push a detail page.

## Pinned Maestro

Upstream Maestro hangs on tvOS (mobile-dev-inc/Maestro PR #3021 is unmerged), so every
platform runs the pinned `plexinc/Maestro` fork `cli-2.8.0.6`. The tier-1 Android smoke
workflow (`.github/workflows/e2e-tier1-android.yml`) uses the same pin through
`bun e2e/suites/screenshots/shots.ts maestro-path`. The binary is downloaded once into
`e2e/reports/shots/tools/<tag>/`, sha256-verified (`MAESTRO_TAG` and `MAESTRO_SHA256` in
`lib/tooling.ts`), and passed to `maestro.py --maestro <binary>`. Apple TV adds
`--platform tvos`. The cache is keyed by tag, so bumping the pin makes `doctor` report the
new one missing until `--fix`, `maestro-path` or the next `run` installs it. The user's
global `maestro` is never used, and there is no AppleScript/DeviceHub fallback.

The fork has no release with the tvOS status-bar fix (`7d5552724318`), so the `apple-tv`
CI job builds the tvOS driver from source and caches it. Remove that build and cache when
`plexinc/Maestro` releases past `cli-2.8.0.6` with the fix, or when upstream merges
PR #3021. The exact criteria are the comment above those steps in
`.github/workflows/e2e-screenshots.yml`.

## Seerr on TV

TV builds have no Seerr settings screen. `seerr.provision_client_access` pushes
`jellyseerrServerUrl` and `jellyseerrApiKey` into the Streamyfin plugin's config, so TV
clients sign in at Jellyfin login without a password. The pushed URL is `127.0.0.1` for
every client, so on Android (phone and TV) the runner adds `adb reverse tcp:<seerr-port>`
to reach the host fixture. It reuses an identical mapping and refuses a conflicting one.
Phones also keep `bootstrap-seerr-mobile.yml` (local settings UI) for refs without
plugin-driven sign-in.

## iOS simulator setup

Run `ios-disable-autofill.sh [udid]` once per booted simulator. It turns Password AutoFill
off by writing the `restrictedBool.allowPasswordAutoFill` value the Settings toggle
writes, because the switch has no stable selector for a flow.

## Operational constraints

- `e2e:enrich` must exit 0 before screenshots run. `run` treats a non-zero enrich as
  fatal.
- Flows prefer the screenshot `testID`s (`more-tab`, `seerr-poster-*`, `seerr-server-url`,
  `intro-done`, `tv-nav-*`) and fall back to text or index for refs without them. The
  fallbacks are less precise. No flow uses coordinate taps.
- The TV flows rely on three TV app behaviors: `TVAddUserForm` takes no preferred focus on
  mount (the login flow presses Down twice from the first field), `TVLibraryToolbar` gives
  Sort the preferred focus on tvOS while the grid loads, and the `(libraries)` tab sets
  `disablePopToTop` on TV. A `before` ref without them fails its pass, so compare against a
  ref that has them.
- The fixture's Jellyfin and Seerr are shared, running services. The runner reuses them,
  never tears them down, and refuses foreign containers via the SyncPlay ownership checks.
