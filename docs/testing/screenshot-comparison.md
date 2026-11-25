# Screenshot comparison

Regressions that a unit test cannot see, such as a restyled header or a missing poster
row, show up as pixels. `e2e/suites/screenshots/` compares two refs screen-for-screen on a
development client served by Metro. It calls a change real only when it beats the run's
own noise floor (a second capture of the *before* build, taken fresh every run).

```sh
bun run e2e:shots:doctor --platform android
bun run e2e:shots --platform android                    # this branch against its base
bun run e2e:shots --platform android --before <base-ref> # a base of your choosing
```

The base comes from `resolveBaseRef` in `scripts/reassure-baseline.ts`, the same choice
the Reassure baseline makes: this branch's PR target from `gh pr view`, else `develop`,
on `upstream` before `origin`. A stacked branch should name its parent, so the parent's
changes don't count as yours. `--after` defaults to `HEAD`, and the runner prints the base
it chose.

A run refuses a dirty tree, identical refs or a physical device. It snapshots the tooling
into the ignored `e2e/reports/shots/`, brings up the local Jellyfin and Seerr fixture,
and switches this checkout between the refs with a Metro restart and a cached debug client
per native fingerprint. It captures the same named shots three times (before, noise,
after) and writes the report and changed-screen evidence into the session directory. On
any exit it restores the starting branch, its dependencies and `ios/` and `android/`, and
stops only a Metro it spawned.

The suite README, `e2e/suites/screenshots/README.md`, is the canonical doc: CI triggers,
the env contract, flow and shot names, the pinned tvOS Maestro fork, Seerr provisioning on
TV, and the limitations.
