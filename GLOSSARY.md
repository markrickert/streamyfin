# Glossary

Domain terms with a fixed meaning in this codebase. When code and docs disagree, the
term as defined here is the one to align to.

## Jellyfin images

- **Artwork** — one concrete image on the server, identified by the triple
  `itemId` + `imageType` + `tag` (plus `index` when an item has several images of one
  type, e.g. multiple backdrops). Represented by the `Artwork` type in
  `utils/jellyfin/image/imageUrl.ts`.
- **Matched pair** — the rule that an artwork's owner ID and its tag come from the same
  item field pair (`ParentThumbItemId`/`ParentThumbImageTag`,
  `ParentBackdropItemId`/`ParentBackdropImageTags`). Mixing them sends a tag the server
  can't verify → 404 → black image. See
  [docs/conventions/images.md](docs/conventions/images.md).
- **Artwork chain** — the ordered fallbacks a surface tries when picking artwork
  (`tvCardLandscape`, `wideCard`, `portraitCard`, `discoveryLandscape`,
  `discoveryPoster`, `primary`), resolved by `resolveArtwork`.
- **Still** — an episode's own `Primary` image: the frame captured from the video,
  drawn in wide cards and hero rows. Called "still" to distinguish it from the series
  poster the episode borrows elsewhere.
- **Tag** — Jellyfin's cache-busting token in `ImageTags.*`, `Parent*ImageTag`, and
  `BackdropImageTags`. A tag-verified request is one the server can fulfil; a tagless
  request is speculative — it may return the type's default image or 404.
- **Cover box** — a `fill` request bounded by `maxWidth`/`maxHeight` so the server
  returns the smallest image that still fills the drawn box. Built by `coverBox`.
- **Points** — React Native layout units, what screens and cards are measured in. All
  caller-facing image params are `*Points`.
- **Pixels** — physical device pixels, `points × PixelRatio.get()`. The unit the server
  sizes images in; confined to `imageUrl`'s `*Px` fields and `toImagePixels`.
