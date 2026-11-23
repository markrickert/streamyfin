# Screenshot comparison

Regressions that a unit test cannot see — a restyled header, a missing poster row — show
up as pixels. `e2e/suites/screenshots/` compares two refs screen-for-screen on a
development client served by Metro, and only calls a change real when it beats the run's
own noise floor (a second capture of the *before* build, taken fresh every run).

```sh
bun e2e/suites/screenshots/shots.ts doctor --platform android
bun e2e/suites/screenshots/shots.ts run --platform android --before develop --after HEAD
```

What it does, in brief: refuses a dirty tree, identical refs or a physical device;
snapshots the suite's tooling into the ignored `e2e/reports/shots/`; brings up the local
Jellyfin + Seerr fixture; switches this checkout between the refs with a per-ref Metro
restart and a locally cached debug client per native fingerprint; captures the same
named shots three times (before / noise / after); and writes the report plus
changed-screen evidence into the session directory. It restores the starting branch and
the `ios/`/`android/` directories on any exit path, and only ever stops a Metro it
spawned itself.

The suite's `README.md` (`e2e/suites/screenshots/README.md`) is the canonical doc: env
contract, per-platform flow names, the tvOS Maestro fork, Seerr provisioning on TV, and
the current limitations. `docs/conventions/testing.md` covers when to prefer this over
Jest.
