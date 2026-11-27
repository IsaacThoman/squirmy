import { useCallback, useMemo } from 'react';
import { ActivityIndicator, StyleSheet, Text } from 'react-native';
import { isArtistSectionKey, releaseGroups } from '../../data/artists';
import { loadFailure } from '../../data/errors';
import { useArtist, useArtistReleases } from '../../data/queries';
import { pageHref } from '../../library/links';
import { Button } from '../Button';
import { useNavigate } from '../routes';
import { colors, type } from '../theme';
import { GridPage } from './CollectionGrid';
import { splitId } from './pageIds';
import { releaseTile } from './releaseTile';

/**
 * Every release under one heading of an artist's discography, from its See all: paged from the
 * server for one of its sections, or the whole list an older server already sent.
 */
export function ReleasesPage({ id }: { id: string }) {
  const [artistId, key] = splitId(id);
  const artist = useArtist(artistId);
  const { tab } = useNavigate();
  const link = useCallback((page: Parameters<typeof pageHref>[1], to: string) => pageHref(tab, page, to), [tab]);
  const group = useMemo(() => artist.data && releaseGroups(artist.data).find(item => item.key === key), [artist.data, key]);
  const paged = isArtistSectionKey(key) && Boolean(artist.data?.sections);
  const releases = useArtistReleases(artistId, isArtistSectionKey(key) ? key : 'album', paged);
  const albums = paged ? releases.items : group?.albums ?? [];
  const items = useMemo(() => albums.map(album => releaseTile(album, key, link, artistId)), [albums, artistId, key, link]);
  const loading = !artist.data || artist.isPlaceholderData || (paged && !releases.data);
  const failed = (artist.isError && !artist.data) ? artist : paged && releases.isError && !releases.data ? releases : null;
  const state = failed
    ? <>
      <Text style={styles.note}>{loadFailure(failed.error).description}</Text>
      <Button label="Try again" icon="arrow.clockwise" onPress={() => void failed.refetch()} hasTVPreferredFocus style={styles.retry} />
    </>
    : loading ? <ActivityIndicator style={styles.loading} color={colors.secondary} />
      : !albums.length ? <Text style={styles.note}>This artist has no releases under this heading.</Text> : null;
  return <GridPage title={group?.title ?? 'Releases'} detail={artist.data?.name} items={items} state={state}
    onEndReached={paged ? releases.loadMore : undefined} loadingMore={paged && releases.isFetchingNextPage} />;
}

const styles = StyleSheet.create({
  loading: { marginTop: 80, alignSelf: 'flex-start' },
  note: { ...type.body, color: colors.secondary, marginTop: 24 },
  retry: { marginTop: 32, alignSelf: 'flex-start' },
});
