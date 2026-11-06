import type { Api } from "@jellyfin/sdk";
import { CryptoDigestAlgorithm, digestStringAsync } from "expo-crypto";
import { File, Paths } from "expo-file-system";
import { Platform } from "react-native";
import {
  getCachedTopShelfImage,
  getCachedTvImage,
  storeTopShelfImage,
  storeTvImage,
} from "@/modules";
import {
  getJellyfinHeadersForUrl,
  optionsWithOptionalHeaders,
} from "@/utils/customHeaders";
import { getAuthHeaders } from "@/utils/jellyfin/jellyfin";
import type { TVDiscoveryPayload } from "./payload";

export async function prepareLauncherArtwork(
  payload: TVDiscoveryPayload,
  api: Api,
  userId: string,
  isCurrent: () => boolean,
): Promise<{ payload: TVDiscoveryPayload; keys: string[] } | null> {
  const keys = new Set<string>();
  const sections = [];
  for (const section of payload.sections) {
    const items = [];
    for (const item of section.items) {
      if (!isCurrent()) return null;
      let imageUrl: string | undefined;
      if (item.imageUrl) {
        const remoteUrl = item.imageUrl;
        const key = await digestStringAsync(
          CryptoDigestAlgorithm.SHA256,
          `${api.basePath}\0${userId}\0${remoteUrl}`,
        );
        if (!isCurrent()) return null;
        const cached =
          Platform.OS === "ios"
            ? getCachedTopShelfImage(key)
            : getCachedTvImage(key);
        if (cached) {
          imageUrl = cached;
        } else {
          const temporary = new File(
            Paths.cache,
            `tv-art-${key}-${Math.random().toString(36).slice(2)}.jpg`,
          );
          try {
            await File.downloadFileAsync(
              remoteUrl,
              temporary,
              optionsWithOptionalHeaders(
                {},
                {
                  ...getAuthHeaders(api),
                  ...getJellyfinHeadersForUrl(remoteUrl, api.basePath),
                },
              ),
            );
            if (!isCurrent()) return null;
            imageUrl =
              (Platform.OS === "ios"
                ? storeTopShelfImage(key, temporary.uri)
                : storeTvImage(key, temporary.uri)) ?? undefined;
          } catch {
            imageUrl = undefined;
          } finally {
            if (temporary.exists) temporary.delete();
          }
        }
        if (imageUrl) keys.add(key);
      }
      items.push({ ...item, imageUrl });
    }
    sections.push({ ...section, items });
  }
  return isCurrent()
    ? { payload: { ...payload, sections }, keys: [...keys] }
    : null;
}
