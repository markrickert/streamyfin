import { Platform } from "react-native";
import { clearTopShelfCache, writeTopShelfCache } from "@/modules";
import type { TVDiscoveryPayload } from "@/utils/tvDiscovery/payload";

export function writeTopShelfPayload(payload: TVDiscoveryPayload): boolean {
  if (Platform.OS !== "ios" || !Platform.isTV) return false;

  try {
    const didWrite = writeTopShelfCache(JSON.stringify(payload));

    if (!didWrite) {
      console.warn("[TopShelf] Native cache writer is unavailable");
    }
    return didWrite;
  } catch (error) {
    console.warn("[TopShelf] Failed to write cache", error);
    return false;
  }
}

export function clearTopShelfCacheSafely(): void {
  if (Platform.OS !== "ios" || !Platform.isTV) return;

  try {
    const didClear = clearTopShelfCache();

    if (!didClear) {
      console.warn("[TopShelf] Native cache clearer is unavailable");
    }
  } catch (error) {
    console.warn("[TopShelf] Failed to clear cache", error);
  }
}
