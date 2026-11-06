import type { Api } from "@jellyfin/sdk";

export const trickplaySheetUrl = (
  api: Api,
  itemId: string,
  resolution: string,
  sheetIndex: number,
  mediaSourceId?: string | null,
): string => {
  const base = api.basePath.replace(/\/+$/, "");
  const path = `${base}/Videos/${encodeURIComponent(itemId)}/Trickplay/${encodeURIComponent(resolution)}/${sheetIndex}.jpg`;
  const params = new URLSearchParams({ ApiKey: api.accessToken ?? "" });
  if (mediaSourceId && mediaSourceId !== itemId) {
    params.set("MediaSourceId", mediaSourceId);
  }
  return `${path}?${params.toString()}`;
};
