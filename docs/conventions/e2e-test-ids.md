# E2E testIDs

Maestro flows under `e2e/suites/*/flows/` select UI elements by `id:`. Each `id:` maps to a `testID` prop in `app/` or `components/`.

## Rules

- Do not rename or remove a `testID` used by a flow without updating the flow files in the same change.
- Compare runs run the current flows against a `before` ref. IDs used without a fallback must already exist on that ref; Android TV's `tv-nav-*` IDs are required. Other screenshot IDs have text or index fallbacks for older refs.
- TV tab ids are derived in `components/tv/TVNavBar.tsx` as `tv-nav-<tab key without parentheses>`, so renaming a tab group renames its id.

## Active testIDs

| testID | Where it is set | Suite flows |
| --- | --- | --- |
| `intro-done` | `components/IntroSheet.tsx` | `screenshots` (`bootstrap-login-mobile.yml`) |
| `login-connect` | `components/login/Login.tsx` | `cast` (`smoke-launch.yml`), `screenshots` (`bootstrap-login-mobile.yml`) |
| `login-server-url` | `components/login/Login.tsx` | `cast` (`smoke-launch.yml`), `screenshots` (`bootstrap-login-mobile.yml`) |
| `more-tab` | `app/(auth)/(tabs)/_layout.tsx` | `screenshots` (`_tap-more.yml`) |
| `seerr-backdrop-ready` | `components/seerr/tv/TVSeerrPage.tsx` | `screenshots` (`seerr-tv.yml`) |
| `seerr-poster-<id>` | `components/posters/SeerrPoster.tsx` | `screenshots` (`seerr-mobile.yml`) |
| `seerr-server-url` | `components/settings/Seerr.tsx` | `screenshots` (`bootstrap-seerr-mobile.yml`) |
| `tv-nav-home` | `components/tv/TVNavBar.tsx` | `screenshots` (`_focus-home-tab.yml`, `_assert-tab-focused.yml`) |
| `tv-nav-libraries` | `components/tv/TVNavBar.tsx` | `screenshots` (`seerr-tv.yml`, `tv.yml`) |
| `tv-nav-search` | `components/tv/TVNavBar.tsx` | `screenshots` (`bootstrap-seerr-tv.yml`, `seerr-tv.yml`, `tv.yml`) |
| `tv-nav-tv-favorites` | `components/tv/TVNavBar.tsx` | `screenshots` (`tv.yml`) |
| `tv-nav-tv-settings` | `components/tv/TVNavBar.tsx` | `screenshots` (`tv.yml`) |
