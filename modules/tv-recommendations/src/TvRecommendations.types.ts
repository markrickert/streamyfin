export interface TvRecommendationsModuleType {
  syncRecommendations(json: string): boolean;
  clearRecommendations(): boolean;
  refreshRecommendations(): boolean;
  getCachedImage(key: string): string | null;
  storeImage(key: string, fileUri: string): string | null;
  pruneImages(keys: string[]): void;
}
