import { albumNote, formatReleaseDate, relatedAlbums, releaseSubtitle, songCountLabel } from '@squirmy/client-core';
import type { AlbumDetail, PlaybackContext, TrackSummary } from '@squirmy/contracts';
import { useCallback, useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { awaitsTrackList } from '../../data/albums';
import { loadFailure } from '../../data/errors';
import { useLibraryActions, useLiked } from '../../data/library';
import { useAlbum, useArtist } from '../../data/queries';
import { useAvailability } from '../../downloads/DownloadsProvider';
import { albumActions } from '../../library/albumActions';
import { pageHref } from '../../library/links';
import { albumCollection, albumTypeLabels, useCollectionDim } from '../../library/shared';
import { usePlaybackActions } from '../../playback';
import { Artwork } from '../Artwork';
import { SystemButton } from '../Button';
import { CollectionLockup } from '../CollectionLockup';
import { chosenPlaylist, rowMenu, useAddToPlaylist, useCollectionMenu, useOpenPage, useOwnPlaylists } from '../menus';
import { Page, PageState } from '../Page';
import { useNavigate } from '../routes';
import { Shelf } from '../Shelf';
import { SongRow } from '../SongRow';
import { colors, tv, type } from '../theme';

const coverSize = 800;

/**
 * An album, as the system's music app lays one out: the cover on the left, and beside it the
 * title, artist, a line of facts, Play, Shuffle, the heart and More, then the songs. Under them
 * the release date and label, and the album's other versions and more by its artist.
 */
export function AlbumPage({ id }: { id: string }) {
  const { query: album } = useAlbum(id);
  const { canPlay, offline, viewer } = useAvailability();
  const actions = usePlaybackActions();
  const liked = useLiked('album', id, album.data?.liked);
  const { setLiked } = useLibraryActions();
  const playlists = useOwnPlaylists();
  const addToPlaylist = useAddToPlaylist();
  const openPage = useOpenPage();
  const { tab } = useNavigate();
  const menu = useCollectionMenu();
  const dim = useCollectionDim();
  const link = useCallback((page: Parameters<typeof pageHref>[1], to: string) => pageHref(tab, page, to), [tab]);
  const data = album.data;
  const leadId = data?.artists[0]?.id;
  const lead = useArtist(leadId ?? '', { enabled: Boolean(leadId), poll: false });
  const leadData = lead.isPlaceholderData ? undefined : lead.data;
  const related = useMemo(() => data ? relatedAlbums(data, leadData) : { versions: [], more: [] }, [data, leadData]);

  if (!data) {
    if (album.isError) return <PageState message={loadFailure(album.error).description} onRetry={() => void album.refetch()} />;
    return <PageState loading />;
  }
  const tracks = data.discs.flatMap(disc => disc.tracks);
  const context: PlaybackContext = { type: 'album', id: data.id, title: data.title };
  const play = (shuffle: boolean, start?: number) => actions.playTracks(tracks, { start, shuffle, context });
  const playable = tracks.some(canPlay);
  const looking = album.isPlaceholderData || awaitsTrackList(data);
  const addRow = () => undefined;
  const rows = albumActions({
    plays: playable, offline, songsKnown: tracks.length > 0, artists: data.artists,
  }, {
    play,
    enqueue: placement => actions.enqueue(tracks, placement),
    addToPlaylist: addRow,
    goToArtist: index => openPage('artist', data.artists[index]!.id),
  // Play, Shuffle and the heart have buttons of their own.
  }).slice(playable ? 2 : 0);
  const more = {
    actions: rowMenu(rows, playlists, addRow),
    onAction: (choice: string) => {
      const playlist = chosenPlaylist(choice, playlists);
      if (playlist) return addToPlaylist(playlist, tracks, `“${data.title}”`);
      rows[Number(choice)]?.onPress();
    },
  };
  const facts = [albumTypeLabels[data.type], data.genres[0], data.year, albumNote(data, viewer)].filter(Boolean).join(' · ');

  return <Page tint={data.artwork?.color} top={tv.pushedTop}>
    <View style={styles.top}>
      <Artwork artwork={data.artwork} size={coverSize} radius={20} focusEffect={false} style={styles.cover} />
      <View style={styles.side}>
        <Text style={styles.title} numberOfLines={2}>{data.title}</Text>
        <Text style={styles.artist} numberOfLines={1}>{data.artistCredit}</Text>
        {facts ? <Text style={styles.facts} numberOfLines={1}>{facts}</Text> : null}
        <View style={styles.buttons}>
          <SystemButton label="Play" icon="play.fill" prominent disabled={!playable} onPress={() => play(false)} />
          <SystemButton icon="shuffle" accessibilityLabel="Shuffle" disabled={!playable} onPress={() => play(true)} />
          {!album.isPlaceholderData && <SystemButton icon={liked ? 'heart.fill' : 'heart'} tint={liked ? colors.accent : undefined}
            accessibilityLabel={liked ? 'Remove from library' : 'Save to library'} onPress={() => setLiked('album', data.id, !liked, data.title)} />}
          <View style={styles.spacer} />
          {more.actions.length > 0 && <SystemButton icon="ellipsis" accessibilityLabel={`More options for ${data.title}`} menu={more} />}
        </View>
        <Tracks album={data} tracks={tracks} looking={looking} onPlay={start => play(false, start)} />
        <AlbumFooter album={data} count={tracks.length} />
      </View>
    </View>
    {related.versions.length > 0 && <Shelf title="Other versions" items={related.versions.map(other => dim(albumCollection(other, link, releaseSubtitle(other))))}
      keyOf={item => item.key} render={item => <CollectionLockup item={item} menu={menu} />} />}
    {related.more.length > 0 && leadData && <Shelf title={`More by ${leadData.name}`}
      items={related.more.map(other => dim(albumCollection(other, link, releaseSubtitle(other))))}
      keyOf={item => item.key} render={item => <CollectionLockup item={item} menu={menu} />} />}
  </Page>;
}

function Tracks({ album, tracks, looking, onPlay }: { album: AlbumDetail; tracks: TrackSummary[]; looking: boolean; onPlay: (start: number) => void }) {
  const discs = album.discs.filter(disc => disc.tracks.length);
  if (!tracks.length) {
    return <Text style={styles.note}>{looking ? 'Looking up the songs…' : 'The server doesn’t know this album’s songs yet.'}</Text>;
  }
  let offset = 0;
  return <View style={styles.tracks}>
    {discs.map(disc => {
      const start = offset;
      offset += disc.tracks.length;
      return <View key={disc.disc}>
        {discs.length > 1 && <Text style={styles.disc}>{disc.title ? `Disc ${disc.disc} · ${disc.title}` : `Disc ${disc.disc}`}</Text>}
        {disc.tracks.map((track, index) => <SongRow key={`${track.id}:${index}`} track={track} number={track.position ?? index + 1}
          subtitle={track.artistCredit !== album.artistCredit ? track.artistCredit : undefined}
          menu={{ album: album.id }} onPress={() => onPlay(start + index)} />)}
      </View>;
    })}
  </View>;
}

function AlbumFooter({ album, count }: { album: AlbumDetail; count: number }) {
  const date = album.releaseDate ? formatReleaseDate(album.releaseDate) : null;
  const label = album.label ? ['℗', album.year, album.label].filter(Boolean).join(' ') : null;
  const lines = [date, count ? songCountLabel(count, { durationMs: album.durationMs, separator: ', ' }) : null, label].filter(Boolean);
  if (!lines.length) return null;
  return <View style={styles.footer}>
    {lines.map(line => <Text key={line} style={styles.footerLine}>{line}</Text>)}
  </View>;
}

const styles = StyleSheet.create({
  top: { flexDirection: 'row', paddingHorizontal: tv.gutter, gap: 80, marginBottom: tv.shelfGap },
  cover: { shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 30, shadowOffset: { width: 0, height: 20 } },
  side: { flex: 1, paddingTop: 10 },
  title: { ...type.largeTitle, fontSize: 64 },
  artist: { ...type.title2, fontWeight: '500', color: colors.secondary, marginTop: 4 },
  facts: { ...type.callout, color: colors.secondary, marginTop: 14 },
  buttons: { flexDirection: 'row', alignItems: 'center', gap: 24, marginTop: 44, marginBottom: 36 },
  spacer: { flex: 1 },
  tracks: { marginHorizontal: -30 },
  disc: { ...type.headline, color: colors.secondary, marginTop: 28, marginBottom: 8, marginHorizontal: 30 },
  note: { ...type.body, color: colors.secondary, marginTop: 20 },
  footer: { marginTop: 44, gap: 6 },
  footerLine: { ...type.callout, color: colors.tertiary },
});
