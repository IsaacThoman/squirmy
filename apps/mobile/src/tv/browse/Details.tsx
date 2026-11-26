import { albumNote, albumPresentation, artistAvailabilityNote, canFetch, releaseSubtitle, songCountLabel } from '@squirmy/client-core';
import type { AlbumDisc, ArtistSectionKey, HistoryItem, LikeEntityType, PlaybackContext, TrackSummary } from '@squirmy/contracts';
import { LinearGradient } from 'expo-linear-gradient';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { FlatList, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useAccount, useSignedInApi, type Api } from '../../account/AccountProvider';
import { awaitsTrackList, trackListWaitMs } from '../../data/albums';
import { appearsOnKey, releaseGroups } from '../../data/artists';
import { shade } from '../../data/color';
import { isNotFound } from '../../data/errors';
import { useLibraryActions, useLiked, useLikeFailure, usePlaylistFailure } from '../../data/library';
import { useAlbum, useArtist, useArtistReleases, useGenreAlbums, useHistory, useLikedTracks, usePlaylist } from '../../data/queries';
import { useAvailability } from '../../downloads/DownloadsProvider';
import { playAllFailure, radioFailure } from '../../library/failures';
import { heartButton } from '../../library/heart';
import { uniqueTracks } from '../../library/loadAll';
import { useStartGuard } from '../../library/pending';
import { usePlayAll } from '../../library/usePlayAll';
import { usePlaybackActions } from '../../playback';
import { TvButton, tvColors } from '../ui';
import { albumCard, artistCard, likedCard, playlistCard, recentCard, type BrowseProps, type BrowseRoute, type Card } from './model';
import { BrowseTrackRow } from './rows';
import {
  BrowseArt, BrowseGrid, BrowseHeader, BrowseLoading, BrowseMessage, BrowseMore, BrowseQuery, BrowseScroll, BrowseShelf, browseInset, browseStyles,
} from './view';

function Favorite({ type, id, title, fromServer }: { type: LikeEntityType; id: string; title: string; fromServer: boolean }) {
  const liked = useLiked(type, id, fromServer);
  const failure = useLikeFailure(type, id);
  const { setLiked } = useLibraryActions();
  const heart = heartButton(liked, title, failure);
  const label = heart.failed ? 'Try saving again' : liked ? '♥  Saved' : '♡  Save';
  return <TvButton label={label} accessibilityLabel={heart.label} selected={heart.selected}
    onPress={() => { setLiked(type, id, !liked, title); }} />;
}

type PageControls = Parameters<typeof BrowseMore>[0];
type Play = (shuffle: boolean, start?: number) => void;

function songCount(tracks: readonly TrackSummary[], durationMs?: number, complete = true) {
  return songCountLabel(tracks.length, { complete, durationMs: durationMs ?? tracks.reduce((sum, track) => sum + track.durationMs, 0) });
}

/** The art and collecting actions stay visible while focus travels down the track list. */
function DetailTracks({ card, subtitle, description, tracks, discs, notes, play, actions, status, controls, menu, extra, empty, loadingPlay }: {
  card: Card; subtitle?: string; description?: string | null; tracks: readonly TrackSummary[];
  discs?: readonly AlbumDisc[]; notes?: string; play: Play; actions?: ReactNode; status?: ReactNode;
  controls?: PageControls; menu: (track: TrackSummary, index: number) => void; extra?: ReactNode;
  empty?: ReactNode; loadingPlay?: boolean;
}) {
  const { width } = useWindowDimensions();
  const artworkSize = Math.min(408, Math.round((width - 2 * browseInset) * 0.27));
  const playback = usePlaybackActions();
  const { canPlay } = useAvailability();
  const plays = tracks.some(canPlay);
  const rows = useMemo(() => {
    const headings = new Map<number, string>();
    if (discs && discs.length > 1) {
      let at = 0;
      for (const disc of discs) {
        if (!disc.tracks.length) continue;
        headings.set(at, disc.title || `Disc ${disc.disc}`);
        at += disc.tracks.length;
      }
    }
    return tracks.map((track, index) => ({ track, index, heading: headings.get(index) }));
  }, [tracks, discs]);
  const tint = card.artworks?.[0]?.color;
  return <View style={styles.detailPage}>
    {tint && <LinearGradient colors={[shade(tint, 0.36), tvColors.background]} start={{ x: 0, y: 0 }} end={{ x: 0.74, y: 0.86 }}
      pointerEvents="none" style={StyleSheet.absoluteFill} />}
    <ScrollView style={[styles.detailAsideWidth, { width: artworkSize + 16 }]} contentContainerStyle={styles.detailAside}
      showsVerticalScrollIndicator={false} contentInsetAdjustmentBehavior="never">
      <BrowseArt artworks={card.artworks} glyph={card.glyph} size={artworkSize} dim={card.dim} />
      <View style={styles.detailHeading}>
        <Text accessibilityRole="header" style={styles.detailTitle}>{card.title}</Text>
        {!!subtitle && <Text style={styles.credit}>{subtitle}</Text>}
        {!!notes && <Text style={browseStyles.subtitle}>{notes}</Text>}
      </View>
      {(plays || !!actions) && <View style={browseStyles.actions}>
        {plays && <>
          <TvButton label={loadingPlay ? 'Loading songs…' : '▶  Play'} accessibilityLabel={loadingPlay ? 'Loading songs' : 'Play'}
            tone="primary" disabled={loadingPlay} onPress={() => play(false)} />
          <TvButton label="Shuffle" disabled={loadingPlay} onPress={() => play(true)} />
        </>}
        {actions}
      </View>}
      {status}
      {!!description && <Text style={browseStyles.subtitle}>{description}</Text>}
    </ScrollView>
    <FlatList style={styles.detailSongs} data={rows} keyExtractor={({ track, index }) => `${track.id}:${index}`}
      ListHeaderComponent={<View style={styles.songsHeader}>
        <Text accessibilityRole="header" style={browseStyles.section}>Songs</Text>
        {tracks.length > 0 && <Text style={browseStyles.subtitle}>{songCount(tracks, undefined, !controls?.hasMore)}</Text>}
      </View>}
      ListEmptyComponent={<>{empty ?? <BrowseMessage title="No songs here yet" />}</>}
      ListFooterComponent={<>{controls && <BrowseMore {...controls} />}{extra}</>}
      onEndReached={controls?.hasMore && !controls.loadingMore && !controls.moreFailed ? controls.loadMore : undefined} onEndReachedThreshold={0.4}
      contentContainerStyle={styles.detailList} contentInsetAdjustmentBehavior="never" showsVerticalScrollIndicator={false}
      removeClippedSubviews={false} initialNumToRender={12} maxToRenderPerBatch={12} windowSize={7}
      renderItem={({ item: { track, index, heading } }) => <>
        {!!heading && <Text accessibilityRole="header" style={styles.disc}>{heading}</Text>}
        <BrowseTrackRow track={track} position={discs ? track.position ?? index + 1 : undefined}
          play={() => { if (!playback.toggleIfCurrent(track.id)) play(false, index); }} onMenu={() => menu(track, index)} />
      </>} />
  </View>;
}

export function AlbumPage({ id, navigate }: BrowseProps & { id: string }) {
  const { query, checkAgain } = useAlbum(id);
  const actions = usePlaybackActions();
  const { viewer } = useAvailability();
  const album = query.data;
  const tracks = useMemo(() => album?.discs.flatMap(disc => disc.tracks) ?? [], [album]);
  const waiting = awaitsTrackList(album);
  const [overdue, setOverdue] = useState(false);
  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(() => setOverdue(true), trackListWaitMs);
    return () => clearTimeout(timer);
  }, [waiting]);

  if (!album || isNotFound(query.error)) return <BrowseScroll><BrowseHeader title="Album" /><BrowseQuery query={query} what="this album" /></BrowseScroll>;
  const play: Play = (shuffle, start) => actions.playTracks(tracks, { shuffle: start === undefined ? shuffle : undefined, start,
    context: { type: 'album', id: album.id, title: album.title } });
  const empty = waiting && !query.isError ? overdue
    ? <BrowseMessage title="Still looking for songs" action={<TvButton label="Check again" onPress={() => {
      setOverdue(false);
      void checkAgain().finally(() => setOverdue(true));
    }} />} />
    : <BrowseLoading label="Looking for songs" />
    : query.isError ? <BrowseQuery query={query} what="this album" /> : undefined;
  const card = { ...albumCard(album), dim: albumPresentation(album, viewer) === 'dimmed' };
  const notes = [releaseSubtitle(album), !query.isPlaceholderData && albumNote(album, viewer)].filter(Boolean).join(' · ');
  return <DetailTracks card={card} subtitle={album.artistCredit} notes={notes} description={album.description}
    tracks={tracks} discs={album.discs} play={play} empty={empty}
    menu={track => navigate({ screen: 'track', track, album: album.id })}
    actions={!query.isPlaceholderData && <Favorite type="album" id={album.id} title={album.title} fromServer={album.liked} />}
    extra={<View style={styles.connections}>
      <View style={browseStyles.actions}>
        {album.artists.map(artist => <TvButton key={artist.id} label={artist.name} tone="quiet"
          onPress={() => navigate({ screen: 'artist', id: artist.id })} />)}
        {album.genres.map(genre => <TvButton key={genre} label={genre} tone="quiet"
          onPress={() => navigate({ screen: 'genre', id: genre })} />)}
      </View>
      {!!album.versions?.length && <View>
        <Text accessibilityRole="header" style={browseStyles.section}>Other versions</Text>
        {album.versions.filter(other => other.id !== album.id).map(other => <TvButton key={other.id} label={other.title}
          accessibilityLabel={`${other.title}, ${releaseSubtitle(other)}`} style={styles.version}
          onPress={() => navigate({ screen: 'album', id: other.id })} />)}
      </View>}
    </View>} />;
}

export function ArtistPage({ id, navigate }: BrowseProps & { id: string }) {
  const query = useArtist(id);
  const actions = usePlaybackActions();
  const api = useSignedInApi();
  const { canPlay, offline, viewer } = useAvailability();
  const radios = useStartGuard();
  const [radioFailed, setRadioFailed] = useState(false);
  const artist = query.data;
  if (!artist || isNotFound(query.error)) return <BrowseScroll><BrowseHeader title="Artist" /><BrowseQuery query={query} what="this artist" /></BrowseScroll>;
  const placeholder = query.isPlaceholderData;
  const groups = releaseGroups(artist);
  const context: PlaybackContext = { type: 'artist', id: artist.id, title: artist.name };
  const play = (shuffle?: boolean, start?: number) => actions.playTracks(artist.topTracks, { shuffle, start, context });
  const art = artist.image;
  const subtitle = ['Artist', artist.disambiguation, !placeholder && artistAvailabilityNote(artist, viewer)].filter(Boolean).join(' · ');
  const startRadio = () => {
    if (!api) return;
    setRadioFailed(false);
    radios.run('artist', () => api.radio.artist(artist.id).then(actions.playRadio, () => setRadioFailed(true)));
  };
  return <BrowseScroll>
    <View style={styles.artistHero}>
      <LinearGradient colors={[shade(art?.color ?? '#62517C', 0.52), tvColors.background]} start={{ x: 0.2, y: 0 }} end={{ x: 1, y: 1 }}
        pointerEvents="none" style={StyleSheet.absoluteFill} />
      <BrowseArt artworks={art ? [art] : undefined} size={260} glyph="♪" round />
      <View style={styles.artistHeading}>
        <BrowseHeader title={artist.name} subtitle={subtitle} />
        {!placeholder && <View style={browseStyles.actions}>
          {artist.topTracks.some(canPlay) && <TvButton label="▶  Play" accessibilityLabel="Play top songs" tone="primary" onPress={() => play(false)} />}
          <Favorite type="artist" id={artist.id} title={artist.name} fromServer={artist.liked} />
          {!offline && (artist.radio ?? (artist.inLibrary || canFetch(viewer))) &&
            <TvButton label={radios.pending('artist') ? 'Starting radio…' : radioFailed ? 'Try radio again' : 'Start radio'}
              disabled={radios.pending('artist')} onPress={startRadio} />}
        </View>}
        {radioFailed && <Text accessibilityRole="alert" style={styles.error}>{radioFailure}</Text>}
      </View>
    </View>
    {placeholder && (query.isError ? <BrowseQuery query={query} what="this artist" /> : <BrowseLoading label="Loading artist" />)}
    {artist.topTracks.length > 0 && <View style={styles.artistSection}>
      <Text accessibilityRole="header" style={browseStyles.section}>Top Songs</Text>
      {artist.topTracks.map((track, index) => <BrowseTrackRow key={`${track.id}:${index}`} track={track}
        play={() => { if (!actions.toggleIfCurrent(track.id)) play(undefined, index); }}
        onMenu={() => navigate({ screen: 'track', track, artist: artist.id })} />)}
    </View>}
    {groups.map(group => <BrowseShelf key={group.key} title={group.title} navigate={navigate}
      cards={group.albums.map(album => albumCard(album, group.key === appearsOnKey ? album.artistCredit : releaseSubtitle(album)))}
      more={group.paged && group.total > group.albums.length ? { label: 'See all', onPress: () => navigate({
        screen: 'releases', id: artist.id, group: group.key as ArtistSectionKey,
      }) } : undefined} />)}
    {artist.similar.length > 0 && <BrowseShelf title="Similar artists" cards={artist.similar.map(artistCard)} navigate={navigate} />}
    {!!artist.bio && <View style={styles.artistSection}>
      <Text accessibilityRole="header" style={browseStyles.section}>About {artist.name}</Text>
      <Text style={browseStyles.subtitle}>{artist.bio}</Text>
    </View>}
  </BrowseScroll>;
}

export function PlaylistPage(props: BrowseProps & { id: string }) {
  if (props.id === 'liked') return <LikedPage {...props} />;
  if (props.id === 'recent') return <HistoryPage {...props} />;
  return <UserPlaylistPage {...props} />;
}

const likedPage = (api: Api, cursor: string, limit: number) => api.userdata.likes('track', { cursor, limit });
const historyPage = (api: Api, cursor: string, limit: number) => api.userdata.history({ cursor, limit });
const historyTracks = (items: readonly HistoryItem[]) => uniqueTracks(items.map(item => item.track));

function LikedPage({ navigate }: BrowseProps) {
  const list = useLikedTracks();
  const all = usePlayAll({ list, fetchPage: likedPage, tracksOf: tracks => [...tracks] });
  const actions = usePlaybackActions();
  if (!list.data) return <BrowseScroll><BrowseHeader title={likedCard.title} /><BrowseQuery query={list} what="your liked songs" /></BrowseScroll>;
  return <DetailTracks card={likedCard} tracks={list.items} notes={likedCard.subtitle}
    menu={track => navigate({ screen: 'track', track })} loadingPlay={!!all.busy}
    empty={<BrowseMessage title="No liked songs yet" detail="Save songs from their menus to see them here." />}
    status={all.failed && <Text accessibilityRole="alert" style={styles.error}>{playAllFailure}</Text>}
    controls={{ hasMore: list.hasNextPage, loadingMore: list.isFetchingNextPage, moreFailed: list.isFetchNextPageError, loadMore: list.loadMore }}
    play={(shuffle, start) => all.run(start, shuffle, tracks => actions.playTracks(tracks, {
      shuffle: start === undefined ? shuffle : undefined, start, context: { type: 'liked', id: null, title: likedCard.title },
    }))} />;
}

function HistoryPage({ navigate }: BrowseProps) {
  const list = useHistory();
  const all = usePlayAll({ list, fetchPage: historyPage, tracksOf: historyTracks });
  const actions = usePlaybackActions();
  if (!list.data) return <BrowseScroll><BrowseHeader title={recentCard.title} /><BrowseQuery query={list} what="your history" /></BrowseScroll>;
  return <DetailTracks card={recentCard} tracks={historyTracks(list.items)} notes={recentCard.subtitle}
    menu={track => navigate({ screen: 'track', track })} loadingPlay={!!all.busy}
    empty={<BrowseMessage title="Nothing played yet" />}
    status={all.failed && <Text accessibilityRole="alert" style={styles.error}>{playAllFailure}</Text>}
    controls={{ hasMore: list.hasNextPage, loadingMore: list.isFetchingNextPage, moreFailed: list.isFetchNextPageError, loadMore: list.loadMore }}
    play={(shuffle, start) => all.run(start, shuffle, tracks => actions.playTracks(tracks, {
      shuffle: start === undefined ? shuffle : undefined, start, context: { type: 'history', id: null, title: recentCard.title },
    }))} />;
}

function UserPlaylistPage({ id, navigate }: BrowseProps & { id: string }) {
  const { state } = useAccount();
  const query = usePlaylist(id);
  const actions = usePlaybackActions();
  const failure = usePlaylistFailure(id);
  const { offline } = useAvailability();
  const playlist = query.data;
  if (!playlist || isNotFound(query.error)) return <BrowseScroll><BrowseHeader title="Playlist" /><BrowseQuery query={query} what="this playlist" /></BrowseScroll>;
  const owned = state.status === 'signedIn' && playlist.ownerId === state.user.id;
  const editable = owned && !offline;
  const tracks = playlist.items.map(item => item.track);
  return <DetailTracks card={playlistCard(playlist)} notes={owned ? 'Playlist' : `Playlist · ${playlist.ownerName}`} description={playlist.description}
    tracks={tracks} menu={(track, index) => navigate({ screen: 'track', track,
      playlist: editable ? { id: playlist.id, itemId: playlist.items[index]!.itemId } : undefined })}
    status={failure && <Text accessibilityRole="alert" style={styles.error}>{failure}</Text>}
    empty={<BrowseMessage title="No songs yet" detail={owned ? 'Add songs to this playlist from any song’s menu.' : undefined} />}
    play={(shuffle, start) => actions.playTracks(tracks, {
      shuffle: start === undefined ? shuffle : undefined, start, context: { type: 'playlist', id: playlist.id, title: playlist.name },
    })} />;
}

export function GenrePage({ id, navigate }: BrowseProps & { id: string }) {
  const list = useGenreAlbums(id);
  return <BrowseGrid cards={list.items.map(album => albumCard(album))} navigate={navigate}
    header={<>
      <BrowseHeader title={id} />
      {!list.data && <BrowseQuery query={list} what="albums in this genre" />}
      {list.data && !list.items.length && <BrowseMessage title="No albums in this genre" />}
    </>}
    page={{ hasMore: list.hasNextPage, loadingMore: list.isFetchingNextPage, moreFailed: list.isFetchNextPageError, loadMore: list.loadMore }} />;
}

export function ReleasesPage({ id, group, navigate }: BrowseProps & { id: string; group: ArtistSectionKey }) {
  const artist = useArtist(id);
  const list = useArtistReleases(id, group, true);
  const title = artist.data ? releaseGroups(artist.data).find(section => section.key === group)?.title : undefined;
  return <BrowseGrid cards={list.items.map(album => albumCard(album, releaseSubtitle(album)))} navigate={navigate}
    header={<>
      <BrowseHeader title={title ?? 'Releases'} subtitle={artist.data?.name} />
      {!list.data && <BrowseQuery query={list} what="these releases" />}
      {list.data && !list.items.length && <BrowseMessage title="No releases here" />}
    </>}
    page={{ hasMore: list.hasNextPage, loadingMore: list.isFetchingNextPage, moreFailed: list.isFetchNextPageError, loadMore: list.loadMore }} />;
}

export function HomeSongList({ section, navigate }: BrowseProps & { section: { id: string; title: string; tracks: readonly TrackSummary[] } }) {
  const actions = usePlaybackActions();
  const card = { key: section.id, title: section.title, subtitle: 'From Home', route: { screen: 'homeSongs', id: section.id } as BrowseRoute,
    artworks: section.tracks[0]?.album?.artwork ? [section.tracks[0].album.artwork] : undefined, glyph: '♫' };
  return <DetailTracks card={card} notes={card.subtitle} tracks={section.tracks} menu={track => navigate({ screen: 'track', track })}
    play={(shuffle, start) => actions.playTracks(section.tracks, {
      shuffle: start === undefined ? shuffle : undefined, start, context: { type: 'other', id: section.id, title: section.title },
    })} />;
}

const styles = StyleSheet.create({
  detailPage: { flex: 1, flexDirection: 'row', gap: 70, paddingHorizontal: browseInset, paddingTop: 26 },
  detailAsideWidth: { flexGrow: 0, flexShrink: 0 },
  detailAside: { paddingTop: 8, paddingBottom: 45, gap: 16 },
  detailHeading: { gap: 6 },
  detailTitle: { fontSize: 42, lineHeight: 47, letterSpacing: -1.1, fontWeight: '700', color: tvColors.text },
  credit: { fontSize: 23, color: tvColors.text },
  detailSongs: { flex: 1 },
  detailList: { paddingBottom: 50 },
  songsHeader: { gap: 3, marginBottom: 19 },
  disc: { color: tvColors.muted, fontSize: 22, marginTop: 14, marginBottom: 7, paddingLeft: 14, fontWeight: '600' },
  connections: { gap: 24, paddingTop: 28, alignItems: 'flex-start' },
  version: { marginTop: 13, alignSelf: 'flex-start' },
  error: { color: tvColors.danger, fontSize: 21 },
  artistHero: { flexDirection: 'row', alignItems: 'center', gap: 48, padding: 36, borderRadius: 24, overflow: 'hidden', marginBottom: 19 },
  artistHeading: { flex: 1, gap: 6 },
  artistSection: { gap: 11, marginTop: 29, maxWidth: 1100 },
});
