/**
 * Height of the title logo on the phone detail pages, in layout points. The
 * parallax header reserves a slot this tall and the logo is drawn to fill it.
 */
export const LOGO_HEIGHT = 130;

/**
 * Encoding quality asked of the server for card and backdrop artwork. Detail
 * pages that show people or key art ask for more; everything in a row gets
 * this.
 */
export const IMAGE_QUALITY = 80;

/**
 * Longest side of an image sized to the box it covers, in physical pixels. A
 * backdrop covering a tall header on a 3x phone would otherwise come back
 * past 2600 pixels wide. 1920 keeps it close to sharp while the decoded
 * bitmap stays around 8 MB for a backdrop and under 15 MB for anything else.
 */
export const MAX_IMAGE_SIDE_PX = 1920;

/**
 * Tallest logo the app asks the server for, in physical pixels. Logos are
 * wide, so a height past this buys a bitmap several thousand pixels across
 * for a slot no screen draws that large.
 */
export const MAX_LOGO_HEIGHT_PX = 600;

/**
 * Card artwork is requested in steps this wide, in physical pixels, rounded
 * up to the next one. A grid column is a few points off a row card and follows
 * the window, so sizing each to the pixel would download one poster again for
 * every width it is drawn at. A step of 100 also lands a poster row on a 2x
 * screen on the 300 pixels it asked for before requests followed the screen,
 * so those caches survive the change.
 */
export const CARD_IMAGE_WIDTH_STEP_PX = 100;

/**
 * Widest card artwork the app asks for, in physical pixels. The widest card
 * drawn today is a grid column of about 180 points on a 3x phone or 240 on a
 * 2x tablet, both under 600 pixels. The cap is there for the window nobody
 * planned for: a poster this wide already decodes to almost 4 MB.
 */
export const MAX_CARD_IMAGE_WIDTH_PX = 800;

/**
 * Decoded bytes the TV image memory cache holds on a 1920x1080 pixel screen.
 * A default-scale TV card is requested at most 300 pixels wide there: a
 * 200x300 poster decodes to 240 KB and a 300x169 landscape card to 200 KB.
 * Home shows about three rows of up to ten cards, so one screen is near 7 MB
 * at the default text scale, or near 16 MB at the largest (300x450 posters).
 * 16 MB keeps a screen at any scale, or two at the default one, so posters
 * scrolled back into view come from memory. Full-screen backdrops (8 MB each)
 * are prefetched to disk only and do not count on this budget.
 */
const TV_IMAGE_MEMORY_CACHE_BYTES_1080P = 16 * 1024 * 1024;

/**
 * The TV image memory cache budget for a screen this many physical pixels
 * across. Card artwork follows the screen's pixel density, so a 4K screen
 * decodes four times the bytes for the same cards.
 */
export const tvImageMemoryCacheBytes = (screenWidthPx: number) =>
  Math.round(TV_IMAGE_MEMORY_CACHE_BYTES_1080P * (screenWidthPx / 1920) ** 2);

/**
 * Decoded bytes the image memory cache holds on phones, which have the RAM
 * a TV box lacks.
 */
export const MOBILE_IMAGE_MEMORY_CACHE_BYTES = 128 * 1024 * 1024;

/** Bytes the image disk cache holds on every platform. */
export const IMAGE_DISK_CACHE_BYTES = 200 * 1024 * 1024;
