import { View } from "react-native";

interface Props {
  index: number;
}
// Dev note might be a good idea to standardize skeletons across the app and have one "file" for it.
export const GridSkeleton: React.FC<Props> = ({ index }) => {
  return (
    <View
      key={index}
      className='flex flex-col mr-2 h-auto'
      style={{ width: "30.5%" }}
    >
      <View className='relative rounded-lg overflow-hidden border border-surface w-full mt-4 aspect-[10/15] bg-surface-raised' />
      <View className='mt-2 flex flex-col w-full'>
        <View className='h-4 bg-surface-raised rounded mb-1' />
        <View className='h-3 bg-surface-raised rounded w-1/2' />
      </View>
    </View>
  );
};
