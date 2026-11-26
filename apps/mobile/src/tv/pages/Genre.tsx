import { useCallback, useMemo } from 'react';
import { ActivityIndicator, StyleSheet, Text } from 'react-native';
import { loadFailure } from '../../data/errors';
import { useGenreAlbums } from '../../data/queries';
import { pageHref } from '../../library/links';
import { albumCollection } from '../../library/shared';
import { Button } from '../Button';
import { useNavigate } from '../routes';
import { colors, type } from '../theme';
import { GridPage } from './CollectionGrid';

/** The albums of one genre, from the genre tiles in Search and the Library. */
export function GenrePage({ id }: { id: string }) {
  const albums = useGenreAlbums(id);
  const { tab } = useNavigate();
  const link = useCallback((page: Parameters<typeof pageHref>[1], to: string) => pageHref(tab, page, to), [tab]);
  const items = useMemo(() => albums.items.map(album => albumCollection(album, link)), [albums.items, link]);
  const state = !albums.data
    ? albums.isError
      ? <>
        <Text style={styles.note}>{loadFailure(albums.error).description}</Text>
        <Button label="Try again" icon="arrow.clockwise" onPress={() => void albums.refetch()} hasTVPreferredFocus style={styles.retry} />
      </>
      : <ActivityIndicator style={styles.loading} color={colors.secondary} />
    : !items.length ? <Text style={styles.note}>{`Albums tagged ${id} show up here.`}</Text> : null;
  return <GridPage title={id} items={items} state={state} onEndReached={albums.loadMore} loadingMore={albums.isFetchingNextPage} />;
}

const styles = StyleSheet.create({
  loading: { marginTop: 80, alignSelf: 'flex-start' },
  note: { ...type.body, color: colors.secondary, marginTop: 24 },
  retry: { marginTop: 32, alignSelf: 'flex-start' },
});
