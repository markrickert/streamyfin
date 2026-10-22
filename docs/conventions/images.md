# Image conventions

Rules for requesting artwork from the Jellyfin server. Every `/Items/{id}/Images/{type}`
URL in the app is built by one module family, `utils/jellyfin/image/`. These rules exist
because their absence shipped real bugs: a Thumb tag sent to a Backdrop endpoint, a tag
truncated to its first character, cards requesting fixed pixels in a point-sized box and
stretching on dense screens.

## Never interpolate `api.basePath` into an image URL

`${api.basePath}/Items/...` never appears outside `utils/jellyfin/image/imageUrl.ts`.
Param names, order, the tag and quality all live in `imageUrl`. A new call site picks a
facade or calls `imageUrl` — it does not assemble the path itself.

## `resolveArtwork` picks, `imageUrl` builds

Selection and construction are separate seams:

- `resolveArtwork(item, chain)` answers "which artwork represents this item here" and
  returns an `Artwork` — `{ itemId, imageType, tag?, index? }`. It is pure: no `api`,
  no `PixelRatio`, nothing to mock.
- `imageUrl(api, artwork, box)` turns an `Artwork` plus a size into the URL. Null in,
  null out, so the two compose: `imageUrl(api, resolveArtwork(item, "wideCard"), box)`.

The fallback chains are data in `resolveArtwork.ts`, named after the surface that uses
them (`tvCardLandscape`, `wideCard`, `portraitCard`, `discoveryLandscape`,
`discoveryPoster`, `primary`) — not the platform, since TV discovery deliberately uses
a card chain. A surface needing a new fallback order gets a new chain there, not a new
conditional at the call site.

## Keep the matched pair together

An `Artwork`'s `itemId`, `imageType` and `tag` belong to one concrete image on the
server. Never mix fields across pairs: `ParentThumbItemId` owns `ParentThumbImageTag`,
`ParentBackdropItemId` owns `ParentBackdropImageTags`, and a Thumb tag must never be
sent to a Backdrop URL — the server 404s and the card renders black. If a new
`Parent*ImageTag` field appears, it joins its own matched step in `resolveArtwork`,
not an existing one.

## Points at the interface, pixels in the implementation

Callers think in layout points; the server sizes in physical pixels.

- Facade params are `widthPoints`/`heightPoints`. `pointsBox` converts once, inside the
  facade, through `toImagePixels` (`PixelRatio.get()`).
- `imageUrl`'s `ImageBox` is pixels only: `fillWidthPx`, `fillHeightPx`, `maxWidthPx`,
  `maxHeightPx`, `widthPx`. The `*Px` suffix is the tell that a value is already
  converted — native-player metadata and download code keep exact pixel budgets and
  call `imageUrl` directly.
- Never convert at the call site and pass the result to a `*Points` param: on a 3x
  display that triple-requests pixels. Issue #2166 was this bug.

## Prefer the facade with your use case's name

`getPrimaryImageUrl`, `getWideImageUrl`, `getPortraitImageUrl`, `getTVPosterImageUrl`,
`getBackdropUrl`, `getParentBackdropImageUrl`, `getLogoImageUrlById` are thin facades —
they pin a chain and a box shape so a call site reads as intent, not plumbing. Reaching
for `resolveArtwork` + `imageUrl` directly is for cases no facade names yet.

## Screen-sized backdrops go through `useBackdropUrl`

`useBackdropUrl(item, box?)` requests a backdrop at the window's pixels by default and
recomputes when the item, dimensions, or box change. A fixed-height surface (a library
card) overrides one side: `useBackdropUrl(item, { heightPoints: CARD_HEIGHT })` keeps
the window width.

## Render through `ServerImage`

URLs built here still render through `Image` from `@/components/common/ServerImage`, so
custom proxy auth headers are attached — see [custom-headers.md](../custom-headers.md).
The native tvOS `GlassPosterView` is the exception: its JS wrapper resolves the same
per-URL headers and passes them as JSON to its native image request.

## Cache limits are platform-specific

`Image.configureCache` sets SDWebImage's limits on iOS/tvOS only. On Android,
`patches/expo-image@57.0.5.patch` caps Glide's disk cache and, on TV, its
separate memory cache and bitmap pool. The TV budget follows
`tvImageMemoryCacheBytes` and never raises Glide's low-memory defaults.
`package.json` opts `expo-image` out of prebuilt Android artifacts so this
patch actually reaches the APK. These limits do not include images still on
screen or the player's own allocations.
