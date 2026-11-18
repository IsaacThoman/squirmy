import { ScrollView, useWindowDimensions, View } from 'react-native';
import { useEffect, useRef, type ReactNode } from 'react';
import type { NativeGesture } from 'react-native-gesture-handler';

export type PageDeckProps = {
  pages: ReactNode[];
  page: number;
  onPageChange: (page: number) => void;
  gesture: NativeGesture;
};

export default function PageDeck({ pages, page, onPageChange }: PageDeckProps) {
  const { width } = useWindowDimensions();
  const deck = useRef<React.ComponentRef<typeof ScrollView>>(null);
  const lastPage = useRef(-1);

  useEffect(() => {
    if (lastPage.current !== page) {
      deck.current?.scrollTo({ x: page * width, animated: lastPage.current !== -1 });
      lastPage.current = page;
    }
  }, [page, width]);

  return (
    <ScrollView
      ref={deck}
      horizontal
      pagingEnabled
      showsHorizontalScrollIndicator={false}
      contentOffset={{ x: page * width, y: 0 }}
      onMomentumScrollEnd={(event) => {
        const next = Math.round(event.nativeEvent.contentOffset.x / width);
        lastPage.current = next;
        onPageChange(next);
      }}
      style={{ flex: 1 }}
    >
      {pages.map((child, index) => <View key={index} style={{ width }}>{child}</View>)}
    </ScrollView>
  );
}
