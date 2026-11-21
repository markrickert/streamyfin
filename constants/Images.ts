/**
 * Height of the title logo on the phone detail pages, in layout points. The
 * parallax header reserves a slot this tall and the logo is drawn to fill it.
 */
export const LOGO_HEIGHT = 130;

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

export const CARD_IMAGE_HEIGHT_STEP_PX = 50;

export const FULLSCREEN_IMAGE_STEP_PX = 100;

export const MAX_FULLSCREEN_IMAGE_PIXELS = 12_000_000;

/**
 * Default JPEG quality for images.
 */
export const IMAGE_QUALITY = 80;

/**
 * JPEG quality of a full-screen backdrop. It is drawn at its own pixel size,
 * so compression blocks show on its gradients and dark scenes at the 80 cards
 * use. 90 is what the backdrop asked for before requests followed the screen.
 */
export const FULLSCREEN_IMAGE_QUALITY = 90;

export const DOWNLOAD_COVER_IMAGE_WIDTH_PX = 500;

/**
 * Widest card artwork the app asks for, in physical pixels. The widest card
 * drawn today is a grid column of about 180 points on a 3x phone or 240 on a
 * 2x tablet, both under 600 pixels. The cap is there for the window nobody
 * planned for: a poster this wide already decodes to almost 4 MB.
 */
export const MAX_CARD_IMAGE_WIDTH_PX = 800;
