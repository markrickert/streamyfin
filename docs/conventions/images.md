# Jellyfin image URLs

Create item artwork through `utils/jellyfin/image/artwork.ts`. That module owns
purpose-based selection and calls `itemImageUrl.ts` to serialize Jellyfin image
URLs. `bun run image-urls:check` rejects hand-built item and user image paths,
SDK image URL builders, and image sizing query assembly outside
`utils/jellyfin/image/`.

## Select by purpose

| Purpose | API | Selection |
| --- | --- | --- |
| General poster | `getArtwork({ purpose: "portrait" })` | Series Primary for an episode, then season Primary, then own Primary |
| Wide card | `getArtwork({ purpose: "wide" })` | Parent/own Thumb, then Backdrop, then own Primary; `preferEpisodeImage` selects the episode still first |
| Detail backdrop | `getArtwork({ purpose: "backdrop" })` | Parent Backdrop for an episode, own Backdrop, then own Primary |
| Logo | `getArtwork({ purpose: "logo" })` | Parent Logo for an episode, own Logo otherwise |
| Person | `getPersonArtwork` | Person Primary with its `PrimaryImageTag` |
| Music | `getMusicArtwork` | Album Primary with `AlbumPrimaryImageTag` for audio, own Primary for other items or as fallback |
| Explicit owner | `getArtworkByOwner` | Supply the image owner's ID, type and *matching* tag together |
| Native artwork | `getArtworkForPixelBudget` | Use purpose-based selection and an explicit physical-pixel budget when no rendered box exists |

Pass the rendered box in layout points (`box.width`, `box.height`), including
the enlarged focused box on TV. The resolver converts it to physical pixels,
rounds card requests to cache-friendly steps and bounds fullscreen decoded
pixels. Portrait cards use width-keyed URLs so nearby sizes share one cached
poster. Top Shelf requests both dimensions with `portraitCover`. Other
cover-fit images must carry both box dimensions. Do not guess the size from
the screen width when the image is drawn in a smaller slot. Blurhashes belong
only to the item that owns the selected image.

## Special deliveries

- `getUserImageUrl.ts` handles pre-login user portraits without an authenticated
  `Api`. `trickplaySheetUrl.ts` handles media-source-dependent trickplay sheets.
  Keep server-supplied streaming URLs untouched.
- Use `components/common/ServerImage.tsx` for image rendering and
  `prefetchServerImage` for prefetch. They resolve custom proxy headers for
  Jellyfin URLs. Downloads must copy the selected image with scoped auth
  headers and render a local data URI or file while offline.
- TV discovery prepares artwork in the signed-in app using authenticated
  downloads, copies it to persistent native storage, then publishes only
  `file://` references inside the tvOS App Group or read-only `content://`
  references from Android's `TvArtworkProvider`. The OS-owned reader must never
  receive a remote authenticated URL, token or custom gateway header. Missing
  artwork leaves the tile and its play link intact. Both native stores cap
  files at 72, total storage at 48 MiB, and individual images at 8 MiB;
  successful publication prunes files no longer referenced by tiles.

When adding an artwork surface, choose its purpose, measure its draw box,
provide the item's image tags and test the rendered URI/headers. For a new
owner rule, add it to the shared resolver and test owner, type, tag and size
together before adding a screen-specific workaround.
