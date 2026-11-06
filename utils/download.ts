import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client";
import { getLibraryApi } from "@jellyfin/sdk/lib/utils/api";
import { useAtom } from "jotai";
import { DOWNLOAD_COVER_IMAGE_WIDTH_PX } from "@/constants/Images";
import useImageStorage from "@/hooks/useImageStorage";
import { apiAtom } from "@/providers/JellyfinProvider";
import { getArtworkByOwner } from "@/utils/jellyfin/image/artwork";
import { storage } from "@/utils/mmkv";

const useDownloadHelper = () => {
  const [api] = useAtom(apiAtom);
  const { saveImage } = useImageStorage();

  const saveSeriesPrimaryImage = async (item: BaseItemDto) => {
    if (
      item.Type === "Episode" &&
      item.SeriesId &&
      api &&
      !storage.getString(item.SeriesId)
    ) {
      const tag =
        item.SeriesPrimaryImageTag ??
        (
          await getLibraryApi(api).getItem({
            itemId: item.SeriesId,
          })
        ).data.ImageTags?.Primary;
      const source = getArtworkByOwner({
        api,
        id: item.SeriesId,
        type: "Primary",
        tag,
        pixels: { width: DOWNLOAD_COVER_IMAGE_WIDTH_PX },
      });
      if (!source?.uri) return;
      await saveImage(item.SeriesId, source.uri);
    }
  };

  return { saveSeriesPrimaryImage };
};

export default useDownloadHelper;
