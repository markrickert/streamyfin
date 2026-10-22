import {
  type BaseItemDto,
  ImageType,
} from "@jellyfin/sdk/lib/generated-client/models";
import { useAtom } from "jotai";
import type React from "react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { ViewProps } from "react-native";
import { CardRow } from "@/components/cards/CardRow";
import useRouter from "@/hooks/useAppRouter";
import { apiAtom } from "@/providers/JellyfinProvider";
import { imageUrl } from "@/utils/jellyfin/image/imageUrl";

interface Props extends ViewProps {
  item?: BaseItemDto | null;
}

export const CurrentSeries: React.FC<Props> = ({ item, ...props }) => {
  const [api] = useAtom(apiAtom);
  const { t } = useTranslation();
  const router = useRouter();

  // The card shows the series this episode belongs to, so it is built by hand
  // rather than from the episode item.
  const cards = useMemo(
    () =>
      item
        ? [
            {
              id: item.Id ?? "series",
              title: item.SeriesName ?? "",
              imageUrl: item.ParentId
                ? imageUrl(
                    api,
                    { itemId: item.ParentId, imageType: ImageType.Primary },
                    { fillWidthPx: 500, quality: 90 },
                  )
                : null,
            },
          ]
        : [],
    [api, item],
  );

  return (
    <CardRow
      {...props}
      title={t("item_card.series")}
      kind='portrait'
      cards={cards}
      onPressId={() =>
        item?.SeriesId && router.push(`/series/${item.SeriesId}` as any)
      }
    />
  );
};
