# A Client's WebSocket Close Can Terminate the Jellyfin Fixture Server

**Date**: 2026-11-26
**Category**: build-and-tooling
**Key files**: `e2e/suites/screenshots/lib/run.ts`, `e2e/suites/screenshots/lib/fixture.ts`, `e2e/suites/syncplay/setup.py`, `e2e/suites/syncplay/compose.yml`

## Detail

Jellyfin 10.11.x and 12.0 can terminate the whole server on an unhandled
`ObjectDisposedException` in `WebSocketController` (`OnConnectionClosed`,
`get_HasOpenSockets`) when a client's WebSockets close — an app relaunch does
exactly that. Upstream: `jellyfin/jellyfin` issue #18053 (open), fix PR #18028
(open, unmerged against master), so no release carries the fix.

Symptom in screenshot runs: a flow relaunches the app, Jellyfin writes `[FTL]
Main: Unhandled Exception` in its log, and the flow then fails on "Server
unreachable" assertions — fixture state, not app state. The fixture compose
service runs `restart: "no"`, so the dead server stays down.

The screenshot runner probes `http://127.0.0.1:<SYNCPLAY_PORT>/health` after a
failed pass. On a miss it runs `bun run e2e:setup` — `setup.main` is idempotent
and `servers.up` restarts a dead server on both the Docker and native backends —
requires the probe to answer 200, keeps the failed attempt as
`<capture>-failed-1`, and retries the pass once, inside the same per-pass budget
as the Maestro driver retry. A final failure while the server is down gets
` (Jellyfin fixture unreachable after the pass)` appended so the report names
the cause.
