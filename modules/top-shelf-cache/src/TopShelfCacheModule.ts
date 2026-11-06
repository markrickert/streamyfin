import { NativeModule, requireNativeModule } from "expo";
import { Platform } from "react-native";
import type { TopShelfCacheModuleEvents } from "./TopShelfCache.types";

declare class TopShelfCacheModuleType extends NativeModule<TopShelfCacheModuleEvents> {
  writeCache(json: string): boolean;
  clearCache(): boolean;
  getCachedImage(key: string): string | null;
  storeImage(key: string, fileUri: string): string | null;
  pruneImages(keys: string[]): void;
}

let TopShelfCacheNativeModule: TopShelfCacheModuleType | null = null;

if (Platform.OS === "ios" && Platform.isTV) {
  try {
    TopShelfCacheNativeModule =
      requireNativeModule<TopShelfCacheModuleType>("TopShelfCache");
  } catch {
    TopShelfCacheNativeModule = null;
  }
}

export const writeTopShelfCache = (json: string): boolean =>
  TopShelfCacheNativeModule?.writeCache(json) ?? false;

export function clearTopShelfCache(): boolean {
  return TopShelfCacheNativeModule?.clearCache() ?? false;
}

export const getCachedTopShelfImage = (key: string): string | null =>
  TopShelfCacheNativeModule?.getCachedImage(key) ?? null;

export const storeTopShelfImage = (
  key: string,
  fileUri: string,
): string | null => TopShelfCacheNativeModule?.storeImage(key, fileUri) ?? null;

export const pruneTopShelfImages = (keys: string[]): void => {
  TopShelfCacheNativeModule?.pruneImages(keys);
};
