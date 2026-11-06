import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client/models";
import { useSegments } from "expo-router";
import { useAtom } from "jotai";
import type React from "react";
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { ViewProps } from "react-native";
import { CARD_LAYOUTS } from "@/components/cards/CardData";
import { CardRow } from "@/components/cards/CardRow";
import useRouter from "@/hooks/useAppRouter";
import { useCastCrew } from "@/hooks/useCastCrew";
import { apiAtom } from "@/providers/JellyfinProvider";
import { getPersonArtwork } from "@/utils/jellyfin/image/artwork";

interface Props extends ViewProps {
  item?: BaseItemDto | null;
  loading?: boolean;
}

export const CastAndCrew: React.FC<Props> = ({ item, loading, ...props }) => {
  const [api] = useAtom(apiAtom);
  const segments = useSegments();
  const { t } = useTranslation();
  const router = useRouter();
  const from = (segments as string[])[2];

  const distinctPeople = useCastCrew(item?.People, { labelRoles: true });

  // People aren't BaseItemDto, so the cards are built here rather than by
  // CardRow's item mapping.
  const cards = useMemo(
    () =>
      distinctPeople.map((person) => {
        const { cardWidth, aspectRatio } = CARD_LAYOUTS.portrait;
        const imageSource = getPersonArtwork({
          api,
          person,
          box: { width: cardWidth, height: cardWidth / aspectRatio },
        });
        return {
          id: person.Id,
          title: person.Name ?? "",
          subtitle: person.Role ?? null,
          imageUrl: imageSource?.uri,
          imageSource,
        };
      }),
    [api, distinctPeople],
  );

  const openPerson = useCallback(
    (personId: string) => {
      router.push({
        pathname: "/persons/[personId]",
        params: { personId },
      });
    },
    [router],
  );

  if (!from) return null;

  return (
    <CardRow
      {...props}
      title={t("item_card.cast_and_crew")}
      kind='portrait'
      cards={cards}
      loading={loading}
      onPressId={openPerson}
    />
  );
};
