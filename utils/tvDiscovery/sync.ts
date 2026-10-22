import type { Api } from "@jellyfin/sdk";
import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client/models";
import * as Crypto from "expo-crypto";
import { Directory, File, Paths } from "expo-file-system";
import { Platform } from "react-native";
import { clearTvRecommendations, syncTvRecommendations } from "@/modules";
import { getJellyfinHeadersForUrl } from "@/utils/customHeaders";
import { getAuthHeaders } from "@/utils/jellyfin/jellyfin";
import {
  clearTopShelfCacheSafely,
  writeTopShelfPayload,
} from "@/utils/topshelf/cache";
import { buildTVDiscoveryPayload, type TVDiscoveryPayload } from "./payload";

const artworkCache = new Directory(Paths.cache, "tv-discovery-images");
const pendingArtwork = new Map<string, Promise<void>>();
let discoveryGeneration = 0;
let artworkEpoch = 0;

async function cacheProtectedArtwork(
  payload: TVDiscoveryPayload,
  api: Api,
  epoch: number,
): Promise<TVDiscoveryPayload> {
  const downloads = new Map<string, Promise<string | undefined>>();
  const localImage = (url: string) => {
    let pending = downloads.get(url);
    if (!pending) {
      pending = (async () => {
        const proxyHeaders = getJellyfinHeadersForUrl(url, api.basePath);
        if (!proxyHeaders) return url;

        try {
          const hash = await Crypto.digestStringAsync(
            Crypto.CryptoDigestAlgorithm.SHA256,
            `${epoch}:${api.accessToken}:${url}`,
          );
          if (!artworkCache.exists) {
            artworkCache.create({ idempotent: true, intermediates: true });
          }
          const file = new File(artworkCache, `${hash}.jpg`);
          let downloading = pendingArtwork.get(hash);
          if (!downloading && !file.exists) {
            downloading = File.downloadFileAsync(url, file, {
              headers: { ...getAuthHeaders(api), ...proxyHeaders },
            })
              .then(() => {})
              .catch((error) => {
                if (file.exists) file.delete();
                throw error;
              })
              .finally(() => pendingArtwork.delete(hash));
            pendingArtwork.set(hash, downloading);
          }
          if (downloading) await downloading;
          if (epoch !== artworkEpoch) {
            if (file.exists) file.delete();
            return undefined;
          }
          return file.uri;
        } catch {
          // A protected URL must never escape into the system-owned image loader.
          console.warn("[TVDiscovery] Could not cache protected artwork");
          return undefined;
        }
      })();
      downloads.set(url, pending);
    }
    return pending;
  };

  return {
    ...payload,
    sections: await Promise.all(
      payload.sections.map(async (section) => ({
        ...section,
        items: await Promise.all(
          section.items.map(async (item) => ({
            ...item,
            imageUrl: item.imageUrl
              ? await localImage(item.imageUrl)
              : undefined,
          })),
        ),
      })),
    ),
  };
}

export async function updateTVDiscovery({
  api,
  sections,
  useEpisodeImages,
}: {
  api: Api | null | undefined;
  sections: Array<{ title: string; items: BaseItemDto[] | undefined }>;
  useEpisodeImages?: boolean;
}): Promise<void> {
  if (!Platform.isTV) return;
  const generation = ++discoveryGeneration;
  const epoch = artworkEpoch;

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

  let prepared: TVDiscoveryPayload;
  try {
    prepared = api ? await cacheProtectedArtwork(payload, api, epoch) : payload;
  } catch {
    console.warn("[TVDiscovery] Could not prepare launcher artwork");
    return;
  }
  if (generation !== discoveryGeneration) return;

  const sectionSummary = prepared.sections
    .map((section) => `${section.title}:${section.items.length}`)
    .join(", ");
  console.log(
    `[TVDiscovery] Sync payload prepared for ${Platform.OS} TV with ${prepared.sections.length} section(s): ${sectionSummary}`,
  );

  if (Platform.OS === "ios") {
    writeTopShelfPayload(prepared, api?.accessToken || undefined);
    return;
  }

  if (Platform.OS === "android") {
    try {
      const didSync = syncTvRecommendations(JSON.stringify(prepared));

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
  ++discoveryGeneration;
  ++artworkEpoch;
  try {
    if (artworkCache.exists) artworkCache.delete();
  } catch {
    console.warn("[TVDiscovery] Could not clear local artwork cache");
  }

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
