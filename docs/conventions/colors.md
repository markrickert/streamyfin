# Colors

Every color of the app is a token of the palette in `constants/Colors.ts`. The same
palette is the only set of colors in `tailwind.config.js`, under kebab-case names:
`Colors.foregroundMuted` is `text-foreground-muted`. `bun scripts/native-palette.ts`
generates that config, so never edit its colors. `no-color-literal` (`biome-plugins/no-color-literal.grit`)
fails `bun run check` on a hex or `rgb()` string, a named color in a style value or
color prop (any string but `transparent`, `none` and `currentColor`), and a Tailwind color
outside the palette (`bg-neutral-900`,
`text-[#8E8D91]`). A Tailwind class outside the palette renders nothing.

```typescript
import { Colors } from "@/constants/Colors";

<View style={{ backgroundColor: Colors.surface }} />
<View className='bg-surface' />
```

## Native code

Kotlin and Swift read the same palette. `scripts/native-palette.ts` (which also writes
`tailwind.config.js`) writes it as a
`Colors` object (`Colors.kt`, `Colors.swift`) into every native module that cannot
import another's files. Its `NATIVE_PALETTE_TARGETS` is the list. After changing a
color in `constants/Colors.ts`, run `bun scripts/native-palette.ts`. `postinstall`
runs it too, so CI and EAS builds, which install first, regenerate the
files from `Colors.ts` and never ship a stale, missing or extra token. The files
stay committed. Never edit a generated file: `scripts/native-palette.test.ts` fails
when one drifts. A module
with no Compose dependency gets ARGB `Int` constants instead of Compose `Color`s.

`scripts/check-native-colors.ts` runs in `bun run check` and fails on a hex number,
`Color(red:)`, `Color.White` or `.white` in a `.kt` or `.swift` file. Use
`Colors.white` or `Colors.surface`, and round to the nearest token as below. A
line that must keep a literal, such as a color the user picked, ends in
`// color-literal-ok: <reason>`. System styles such as `.primary`, `.secondary`
and `.clear` are not flagged.

## Which token

| Token | Tailwind | Use it for |
| --- | --- | --- |
| `primary` | `bg-primary` | Brand color: primary buttons, selection, progress |
| `primaryDark` | `border-primary-dark` | Borders on a primary fill |
| `accent` | `text-accent` | Lighter brand color for text, icons and switches on a dark surface, and the lighter fill beside a `primary` one (a chart's second segment) |
| `foreground` | `text-foreground` | Text and icons |
| `foregroundMuted` | `text-foreground-muted` | Secondary text, section headers, inactive icons |
| `foregroundDisabled` | `text-foreground-disabled` | Disabled and placeholder text, empty state icons, a sheet's grab handle |
| `surface` | `bg-surface` | Sheets, cards and panels |
| `surfaceRaised` | `bg-surface-raised` | Rows, inputs and anything sitting on a surface |
| `border` | `border-border` | Separators and outlines. Never text: text on a white fill is `black` |
| `white` | `bg-white` | White fills such as a focused TV button, and light overlays |
| `black` | `bg-black` | Page background, text on white, shadows and dark overlays |
| `danger`, `dangerLight` | `text-danger`, `text-danger-light` | Errors, destructive actions, the LIVE badge. The light shade is for text and icons on a dark surface and for borders on a danger fill |
| `success`, `successLight` | `text-success`, `text-success-light` | Success and available states |
| `warning`, `warningLight` | `bg-warning`, `text-warning-light` | Warning fills and pending states. The light shade is for ratings and warning text |
| `info`, `infoLight` | `text-info`, `text-info-light` | Links, informational badges, processing states |
| `favorite` | `text-favorite` | The favorite heart |

Translucent variants have their own names. Use them instead of an alpha of your own:

- `white05`, `white10`, `white20`, `white30`, `white50`, `white80` (`bg-white/10`)
- `black10`, `black30`, `black50`, `black60`, `black80` (`bg-black/60`)
- `primarySubtle`, `dangerSubtle`, `successSubtle`, `warningSubtle`, `infoSubtle`: a
  status tint behind its own colored text or icon (`bg-danger-subtle`), or a faint
  edge around its own fill
- `surfaceTranslucent`: a sheet's backing on Android TV, where a BlurView only tints

## White

- Text and icons on a dark surface are `foreground`, not `white`.
- A white fill, border or shadow is `white`, never `foreground`. Text on it is `black`.
- Text over video, artwork and a backdrop may be `white50` or `white80`: the
  translucency is what keeps it readable over a changing picture. On a solid surface
  use `foregroundMuted` or `foregroundDisabled`.

## Not a palette color

A color that is data goes to a named group in `constants/Colors.ts`, never to a
`biome-ignore`:

- `SubtitleColors`: the colors a user can pick for subtitles. They are saved in
  settings by value, so a value must never change.
- `SERVER_GRADIENT_COLORS`: the decorative gradients of the TV server icons.
- `EXOPLAYER_CLEAR_COLOR`: a clear color in the form the ExoPlayer view parses.

A variant prop such as `<Button color='purple'>` is not a color and the rule does not
flag it.

## When nothing fits

Round to the nearest token. Do not add a one-off token or a literal: two near
identical grays are how the palette had five whites. If the nearest token looks wrong
on screen, change the token, in one place, for the whole app. Add a token only for a
new job that no existing token does, with a row in the table above.
