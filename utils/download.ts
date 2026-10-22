import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client";
import { ImageType } from "@jellyfin/sdk/lib/generated-client/models";
import { useAtom } from "jotai";
import useImageStorage from "@/hooks/useImageStorage";
import { apiAtom } from "@/providers/JellyfinProvider";
import { imageUrl } from "@/utils/jellyfin/image/imageUrl";
import { storage } from "@/utils/mmkv";

const useDownloadHelper = () => {
  const [api] = useAtom(apiAtom);
  const { saveImage } = useImageStorage();

  const saveSeriesPrimaryImage = async (item: BaseItemDto) => {
    if (
      item.Type === "Episode" &&
      item.SeriesId &&
      !storage.getString(item.SeriesId)
    ) {
      await saveImage(
        item.SeriesId,
        imageUrl(
          api,
          { itemId: item.SeriesId, imageType: ImageType.Primary },
          { fillWidthPx: 500, quality: 90 },
        ),
      );
    }
  };

  return { saveSeriesPrimaryImage };
};

export default useDownloadHelper;
