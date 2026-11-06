/**
 * How long, in ms, a play link from the TV home screen waits for the server
 * to say what the item is before it starts playback anyway. The lookup only
 * exists to keep a container out of the player, so it must not be able to
 * hold up a launch: the SDK's axios instance has no timeout of its own, and
 * an unreachable server would otherwise leave the screen black for as long as
 * the OS keeps the socket open.
 */
export const TOP_SHELF_PLAY_LOOKUP_TIMEOUT = 3000;

export const TV_LAUNCHER_POSTER_WIDTH_PX = 400;
export const TV_LAUNCHER_POSTER_HEIGHT_PX = 600;
export const TV_LAUNCHER_WIDE_WIDTH_PX = 960;
export const TV_LAUNCHER_WIDE_HEIGHT_PX = 540;
export const TV_DISCOVERY_OWNER_KEY = "tvDiscoveryOwner";
