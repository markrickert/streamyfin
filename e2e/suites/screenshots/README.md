# Screenshot comparison suite

Compares two refs screen-for-screen on a development client: the runner switches this
checkout between the refs, serves each with its own Metro, captures the same shots three
times — before, a fresh "noise" pass on the before build, after — and scores them with
`compare.ts`, which judges a change only when it beats the run's own noise floor.
The runner uses local debug clients, never CI release artifacts.

## Commands

```sh
bun e2e/suites/screenshots/shots.ts doctor [--platform ios|android|android-tv|apple-tv]
bun e2e/suites/screenshots/shots.ts run --platform <p> --before <ref> --after <ref> [--device <id>] [--out <dir>] [--port <port>]
```

`doctor` is read-only: tree cleanliness, fixture reachability, driver availability.
`run` refuses a dirty tree, identical refs, a physical device, or a busy port, then:

**Device safety**: use a fresh, dedicated emulator/simulator. Before installing, the
runner checks whether the built app's exact id already exists on the device (`pm path`
on Android, `simctl listapps` on iOS/tvOS) and **refuses unless this run installed it**
— every capture clears the test app's data, so a preexisting install (release or debug)
is user data the runner never replaces or wipes. A same-id reinstall for the after ref
is allowed only because the run itself owns the install from the before ref. On iOS the
per-pass reset uninstalls and reinstalls only the built app, never the whole simulator.

1. Snapshots the suite's tooling (flows, run.sh, compare.ts, masks, `e2e/bench/maestro.py`,
   this runner) into `e2e/reports/shots/<session>/tooling`, so the checked-out ref cannot
   change the tools mid-run. `e2e/reports/` is gitignored.
2. Brings up the local fixture: `bun run e2e:setup`, `e2e:seed`, `e2e:enrich`, then Seerr
   catalog enablement + plugin provisioning via `suites.syncplay.seerr`. It never runs
   `e2e:down` — the fixture stays up afterwards.
3. For the before ref, then the after ref: `git switch --detach` (never `--force`),
   `bun install --frozen-lockfile` when the lockfile changed, `@expo/fingerprint` with the
   platform's `EXPO_TV` (same recipe as `.github/workflows/build-apps.yml`), reuse of the
   cached debug client in `e2e/reports/shots/build-cache/<platform>/<hash>` or a local
   debug build (`./gradlew assembleDebug` / `xcodebuild … Debug`), install on the chosen
   simulator/emulator, a runner-owned `expo start --dev-client --clear` on a port it proved
   free first, then the capture flows with `--env` forwarded by `run.sh`.
4. `compare.ts --before … --noise … --after …` with the platform masks; the report and
   changed-screen evidence land in the session directory.

On success, failure, or Ctrl-C the runner stops only its own Metro, switches back to the
starting branch or detached SHA (never forcing), and restores `ios/`/`android/` from the
session backup: a clean prebuild only happens on a cache miss, and the user's native
dirs are moved aside first, never deleted.

## Environment contract (flows)

The runner exports these per platform; `run.sh` forwards every `MAESTRO_*` as `--env`
arguments to `maestro.py`, which masks them when it echoes its command line.

| Variable | ios / apple-tv | android / android-tv |
| --- | --- | --- |
| `MAESTRO_APP_ID` | the built app's bundle id | the built APK's applicationId (`.debug` on current refs, may be unsuffixed on older ones) |
| `MAESTRO_JELLYFIN_URL` | `http://127.0.0.1:<SYNCPLAY_PORT>` | `http://10.0.2.2:<SYNCPLAY_PORT>` |
| `MAESTRO_JELLYFIN_USER` | `syncplay-host` | same |
| `MAESTRO_JELLYFIN_PASS` | the fixture password | same |
| `MAESTRO_SEERR_URL` | `http://127.0.0.1:<SYNCPLAY_SEERR_PORT>` | `http://10.0.2.2:<SYNCPLAY_SEERR_PORT>` |
| `MAESTRO_SEERR_PASS` | the fixture password | same |

Flows are keyed by platform: `bootstrap-login-mobile|tv`, `mobile|tv`,
`bootstrap-seerr-mobile|tv`, `seerr-mobile|tv`; Apple TV shares the `tv` flows and branches on
`MAESTRO_TVOS`. Screenshot names are the
pairing key for compare.ts — `00-login`, `00-intro` (phones only: `Home.tv.tsx` never
presents the sheet), `01`–`09`, `10`–`12` for Seerr. `10-seerr-discover` is scored
informational: its TMDB feed is live data.

## Apple TV uses the tvOS Maestro fork

Upstream Maestro hangs on tvOS (mobile-dev-inc/Maestro PR #3021 is unmerged), so the
apple-tv path runs the pinned `plexinc/Maestro` fork `cli-2.8.0.6`: downloaded once into
`e2e/reports/shots/tools/`, sha256-verified (`fd9abfd3…`, see `TVOS_FORK_SHA256` in
shots-lib.ts), and invoked as `maestro --platform tvos --device <udid>` through
`maestro.py --maestro <fork> --platform tvos`. The user's global `maestro` is never
touched, and there is no AppleScript/DeviceHub fallback.

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
- Flows prefer the screenshot `testID`s (`screenshots-more-tab`, `seerr-poster-*`,
  `seerr-server-url`, `intro-done`) and use text/index fallbacks for refs without them.
  Those fallbacks are less precise; no flow uses coordinate taps.
- The fixture's Jellyfin and Seerr are shared, running services: the runner reuses them,
  never tears them down, and refuses foreign containers via the SyncPlay ownership checks.
