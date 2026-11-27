# Screenshot comparison suite

Compares two refs screen-for-screen. The runner switches this checkout between the refs,
captures the same shots three times (before, a fresh "noise" pass on the before build,
and after), and scores them with `compare.ts`. A change counts only when it beats the
run's own noise floor.

The runner builds its own clients, never CI release artifacts. `ios`, `apple-tv` and
`android-tv` run a debug dev client against Metro; the Android phone repacks each ref's
JS bundle into a cached Release APK and runs with no Metro. It needs a simulator or
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
- **`workflow_dispatch`**: `before` (required), `after` (default: dispatched ref),
  `platforms` (subset of `ios,apple-tv,android,android-tv`, default all), and `repeat`
  (1–20, default 1): capture attempts per platform, for repeated measurement.

The `plan` job validates `platforms` and `repeat`, and skips a job whose matrix is
empty.

- `ios`, `apple-tv` run on `xcode-27` with the native fixture. Apple silicon runners
  cannot run Docker or an Android emulator. Only `ios` runs `ios-disable-autofill.sh`.
- `android`, `android-tv` run on `ubuntu-26.04` with KVM, the Docker fixture and
  `reactivecircus/android-emulator-runner` (API 34 `x86_64`; `tv_1080p` for TV). Teardown
  falls back to `sudo rm -rf` on `e2e/suites/syncplay/.state` for root-owned Docker files.
- One fixture job per runner family warms the enriched fixture and pinned Maestro
  caches before capture fan-out starts. `apple-fixture` also warms the native fixture
  tools and, when Apple TV is requested, the fixed tvOS Maestro driver. The fixture
  state lives at `e2e/suites/syncplay/.state`, minus `seerr/` (its container uid cannot
  survive a round trip; `seerr.ensure_ready` re-onboards it), `logs/` and `*.pid`. The
  key is `<os>-<arch>-syncplay-state-v2-<ISO week>-<hash of fixture inputs>`: the week
  rolls it weekly so plugin and TMDB data do not freeze, and the input hash rolls it on
  seed/enrich changes. On a miss `doctor --fix` warms the fixture, the servers come
  down for a consistent save, and the state uploads under the same key. Capture jobs
  wait for their family fixture job, then keep the same restore/warm/save steps as a
  fallback without multiplying first-time downloads.

Native builds happen once per platform in `<x>-native` jobs (`shots.ts build`): a
Release repack base for `android`, a debug dev client for the rest. Each `repeat`
attempt is a separate capture job that never builds. The native job hands its
build cache to this run's capture jobs as `shots-native-run-<platform>` (a tar of
`e2e/reports/shots/build-cache/<platform>/`, retained 1 day, never fetched across runs),
and capture jobs run with `SHOTS_NO_BUILD=1` so a missing entry fails instead of
compiling.

Dev clients are also shared across runs as `shots-dev-client-<platform>-<hash>` (a tar,
to keep `.app` permissions and symlinks, retained 90 days). The fetch hook accepts only
artifacts whose `workflow_run.head_repository_id` is this repository and whose expiry is
at least 14 days out — a client about to die counts as missing, so the native job
rebuilds and re-uploads it. Only trusted runs upload (pushes to `develop`,
same-repository PRs, `workflow_dispatch`), so a fork PR cannot plant a binary under
another run's fingerprint.

Jobs fail only on runner, build or capture errors, blank screenshots included. Changed
screens go to `$GITHUB_STEP_SUMMARY` and upload as
`e2e-screenshots-<platform>-report-<attempt>` next to
`e2e-screenshots-<platform>-fixture-logs-<attempt>`. The summary also links the
contact sheet and, on a failed pass, the failing step's screenshot: both upload as
single-file unzipped artifacts (`archive: false`, named `shots-<platform>-<attempt>.png`
and `shots-failure-<platform>-<attempt>.png`), whose `artifact-url` opens the image in
the browser for a signed-in user — GitHub strips `data:` images from summaries.

## Commands

```sh
bun run e2e:shots:doctor [--fix] [--platform ios|android|android-tv|apple-tv]
bun run e2e:shots --platform <p> [--before <ref>] [--after <ref>] [--device <id>] [--out <dir>] [--port <port>]
bun e2e/suites/screenshots/shots.ts build --platform <p> [--before <ref>] [--after <ref>] [--abi <abi>] [--out <dir>]
```

`--before` defaults to the base the Reassure baseline measures against (`resolveBaseRef`
in `scripts/reassure-baseline.ts`): the PR target, else `develop`, on `upstream` before
`origin`. A stacked branch should pass its parent. `--after` defaults to `HEAD`.

`doctor` reports tree cleanliness, fixture reachability, and whether the pinned Maestro is
installed. It is read-only unless you pass `--fix`, which brings up an unhealthy fixture
the way `run` does (step 2) and installs the pinned Maestro. It never touches a dirty
tree.

`build` runs only step 3's native half for both refs — switch, install, fingerprint,
the cached client — with no device, fixture, Maestro or Metro, and writes the same
`<out>/build-cache.json`. `--abi` is required for `android`/`android-tv` (there is no
device to ask) and ignored for Apple platforms. CI's `<x>-native` jobs use it; locally it
warms `e2e/reports/shots/build-cache` for a later `run`.

`run` refuses a dirty tree, a physical device or a busy port, then:

1. Snapshots the tooling (flows, `run.sh`, `compare.ts`, masks, `e2e/bench/maestro.py`)
   into the gitignored `e2e/reports/shots/<session>/tooling`, so the checked-out ref cannot
   change it mid-run.
2. Brings up the fixture (`e2e:setup`, `e2e:seed`, `e2e:enrich`) and provisions Seerr via
   `suites.syncplay.seerr`. It never runs `e2e:down`.
3. For each ref: `git switch --detach` (never `--force`), `bun install --frozen-lockfile`
   if the lockfile changed, `@expo/fingerprint` with the platform's `EXPO_TV` (the recipe
   of `.github/workflows/build-apps.yml`), then the native client from the local cache
   `e2e/reports/shots/build-cache/<platform>/<hash>`, else `SHOTS_BUILD_CACHE_FETCH`
   (`<exe> <platform> <hash> <cacheDir>`), else a local build. Each ref's
   `{ ref, platform, hash, source, path }` goes to `<session>/build-cache.json`.
   - `ios`, `apple-tv`, `android-tv`: installs the debug client, starts its own
     `expo start --dev-client` on a free port — `--clear` on the first Metro, and on a
     later ref only when `git diff --quiet` shows `babel.config.js`, `metro.config.js`
     or `bun.lock` changed — and deep-links the client into it.
   - `android`: the cached client is a Release APK (`assembleRelease` with minify and
     resource shrinking off, signed with the debug keystore). Before the first switch
     the runner stages `repack-runner.ts`, `scripts/ci/repack-android.ts` and a pinned
     `@expo/repack-app` install under `<session>/tooling/repack/`, so a `before` ref
     that lacks them cannot matter. Then `repackForRef` runs the driver once per ref —
     `export:embed` inside the checked-out ref, `jsBundleOnly` repack of the cached
     base into `<session>/app-<ref>.apk` — logs stdout and stderr to
     `<session>/repack-<ref>.log`, and verifies the packed bundle before install. The
     export runs with `EXPO_PUBLIC_SENTRY_DSN=https://e2e@sentry.invalid/0`: a release
     build cannot tell it is on an emulator (`isDevice` is unknown on Android), so a
     real DSN would report capture failures to production. The check is the sentinel's
     presence in `assets/index.android.bundle`, because `PROJECT_SENTRY_DSN` in
     `utils/sentry.ts` stays a literal in every bundle. The repacked APK is what gets
     installed; the noise pass reuses the before one. There is no Metro, no bundle
     warm and no dev-client deep link — `MAESTRO_DEV_CLIENT_URL` is unset and each
     pass opens the app through the flow's own `launchApp`.
   Then each pass runs as one parent Maestro invocation. The session's first pass
   reinstalls Maestro's driver;
   every later pass, a retry included, runs with `--no-reinstall-driver`. A pass whose
   Maestro driver becomes unreachable (`DeviceUnreachableException` in
   `<pass>/maestro.log`) is retried once, and the failed attempt is kept next to it as
   `<capture>-failed-1`. A failed pass that leaves Jellyfin's `/health` unanswered —
   the server can die on a client's WebSocket close (upstream issue #18053, still
   unfixed) — restarts the fixture with `e2e:setup` and is retried once inside the
   same per-pass budget; a final failure while the server stays down gets
   ` (Jellyfin fixture unreachable after the pass)` appended to the thrown error.
4. Runs `compare.ts --before … --noise … --after …` with the platform masks. The report
   and changed-screen evidence land in the session directory, along with
   `contact-sheet.png`: every composite stacked under a label strip in the summary's
   order (red for changed screens, gray otherwise).

`<hash>` is `<fingerprint>-<recipe>`: `DEV_CLIENT_RECIPE` (`r2`) for the debug clients,
`BUILD_RECIPE` (`r3-release`) for the phone's Release base. Bump the matching constant in
`lib/build.ts` when a runner change alters the native output, which the fingerprint
cannot see. On Android the
hash also carries the emulator's first ABI (`ro.product.cpu.abilist`), which is passed to
Gradle as `-PreactNativeArchitectures`.

On success, failure or Ctrl-C the runner stops only its own Metro, returns to the starting
branch or SHA, reinstalls dependencies if the lockfile differs, and restores `ios/` and
`android/` from the session backup. Your native dirs are moved aside, never deleted.

On a failure the runner writes `<session>/report/summary.md` before cleaning up — on
success `compare.ts` owns that file. It carries the thrown error and, when a Maestro
pass failed, the pass label and the failing step recovered from the pass's
`commands.json`: the flow chain, the command, its message, and the screenshot and
screen hierarchy Maestro captured, copied into `report/failure/`. The thrown error
leads with the same step (`flow pass-mobile failed at mobile.yml > …: tapOnElement: …`),
so a CI log names the failing command rather than whatever warning ended the output.

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
| `MAESTRO_DEV_CLIENT_URL` | the dev-client deep link to `http://127.0.0.1:<port>` | `android-tv` only: the dev-client deep link to `http://10.0.2.2:<port>`; unset on `android`, whose Release app has no dev client |
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
