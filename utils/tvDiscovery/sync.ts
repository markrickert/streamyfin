import type { Api } from "@jellyfin/sdk";
import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client/models";
import { Platform } from "react-native";
import { TV_DISCOVERY_OWNER_KEY } from "@/constants/TVDiscovery";
import {
  clearTvRecommendations,
  pruneTopShelfImages,
  pruneTvImages,
  syncTvRecommendations,
} from "@/modules";
import { storage } from "@/utils/mmkv";
import {
  clearTopShelfCacheSafely,
  writeTopShelfPayload,
} from "@/utils/topshelf/cache";
import { prepareLauncherArtwork } from "./launcherArtwork";
import { buildTVDiscoveryPayload } from "./payload";

let revision = 0;

export async function updateTVDiscovery({
  api,
  userId,
  sections,
  useEpisodeImages,
}: {
  api: Api | null | undefined;
  userId?: string | null;
  sections: Array<{ title: string; items: BaseItemDto[] | undefined }>;
  useEpisodeImages?: boolean;
}): Promise<void> {
  if (!Platform.isTV) return;

  if (!api?.accessToken || !userId) {
    clearTVDiscoverySafely();
    return;
  }
  const owner = `${api.basePath}\0${userId}`;
  if (storage.getString(TV_DISCOVERY_OWNER_KEY) !== owner) {
    clearTVDiscoverySafely();
    storage.set(TV_DISCOVERY_OWNER_KEY, owner);
  }
  const thisRevision = ++revision;
  const payload = buildTVDiscoveryPayload({
    api,
    sections,
    // Google TV forces landscape home tiles; Apple TV renders 2:3 posters.
    imageShape: Platform.OS === "android" ? "landscape" : "poster",
    useEpisodeImages,
  });

  if (!payload) {
    console.log("[TVDiscovery] No payload generated; clearing TV discovery");
    clearTVDiscoverySafely();
    return;
  }

  const prepared = await prepareLauncherArtwork(
    payload,
    api,
    userId,
    () => thisRevision === revision,
  );
  if (!prepared || thisRevision !== revision) return;

  const sectionSummary = payload.sections
    .map((section) => `${section.title}:${section.items.length}`)
    .join(", ");
  console.log(
    `[TVDiscovery] Sync payload prepared for ${Platform.OS} TV with ${payload.sections.length} section(s): ${sectionSummary}`,
  );

  if (Platform.OS === "ios") {
    if (writeTopShelfPayload(prepared.payload)) {
      pruneTopShelfImages(prepared.keys);
    }
    return;
  }

  if (Platform.OS === "android") {
    try {
      const didSync = syncTvRecommendations(JSON.stringify(prepared.payload));
      if (didSync) pruneTvImages(prepared.keys);

      console.log(`[TVDiscovery] Android sync result: ${didSync}`);

      if (!didSync) {
        console.warn(
          "[TVDiscovery] Android recommendations sync is unavailable",
        );
      }
    } catch (error) {
      console.warn(
        "[TVDiscovery] Failed to sync Android recommendations",
        error,
      );
    }
  }
}

export function clearTVDiscoverySafely(): void {
  if (!Platform.isTV) return;

  revision++;
  storage.remove(TV_DISCOVERY_OWNER_KEY);
  console.log(`[TVDiscovery] Clearing TV discovery for ${Platform.OS} TV`);

  if (Platform.OS === "ios") {
    clearTopShelfCacheSafely();
    return;
  }

  if (Platform.OS === "android") {
    try {
      const didClear = clearTvRecommendations();

      console.log(`[TVDiscovery] Android clear result: ${didClear}`);

      if (!didClear) {
        console.warn(
          "[TVDiscovery] Android recommendations clearer is unavailable",
        );
      }
    } catch (error) {
      console.warn(
        "[TVDiscovery] Failed to clear Android recommendations",
        error,
      );
    }
  }
}
