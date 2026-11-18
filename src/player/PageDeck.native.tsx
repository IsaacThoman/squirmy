import { useEffect, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { GestureDetector } from 'react-native-gesture-handler';
import PagerView from 'react-native-pager-view';
import type { PageDeckProps } from './PageDeck';

export default function PageDeck({ pages, page, onPageChange, gesture }: PageDeckProps) {
  const pager = useRef<PagerView>(null);
  const nativePage = useRef(page);

  useEffect(() => {
    if (page !== nativePage.current) {
      pager.current?.setPage(page);
      nativePage.current = page;
    }
  }, [page]);

  return (
    <GestureDetector gesture={gesture}>
      <PagerView
        ref={pager}
        style={styles.pager}
        initialPage={nativePage.current}
        overdrag={false}
        onPageSelected={(event) => {
          const next = event.nativeEvent.position;
          nativePage.current = next;
          onPageChange(next);
        }}
      >
        {pages.map((child, index) => (
          <View key={index} collapsable={false} style={styles.page}>
            {child}
          </View>
        ))}
      </PagerView>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  pager: { flex: 1 },
  page: { width: '100%', height: '100%' },
});
