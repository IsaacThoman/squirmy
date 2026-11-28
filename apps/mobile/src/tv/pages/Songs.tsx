import { songCountLabel } from '@squirmy/client-core';
import type { HomeSection, PlaybackContext, TrackSummary } from '@squirmy/contracts';
import { useCallback, useMemo, type ReactElement } from 'react';
import { loadFailure } from '../../data/errors';
import { useArtist, useHome } from '../../data/queries';
import { useAvailability } from '../../downloads/DownloadsProvider';
import { usePlaybackActions } from '../../playback';
import { SystemButton } from '../Button';
import { PageState } from '../Page';
import { CollectionArt } from './CollectionArt';
import { splitId } from './pageIds';
import { artSize, TrackListPage } from './TrackListPage';

/** Every song of a section that shows only its first few: an artist's top songs, or a Home row. */
export function SongsPage({ id }: { id: string }) {
  const [source, ref] = splitId(id);
  return source === 'home' ? <HomeSongs sectionId={ref} /> : <TopSongs artistId={ref} />;
}

function TopSongs({ artistId }: { artistId: string }) {
  const artist = useArtist(artistId);
  const loaded = artist.data;
  // Made once per artist, so the rows' Play is not new each time the page draws.
  const context = useMemo((): PlaybackContext | null => (loaded ? { type: 'artist', id: loaded.id, title: loaded.name } : null), [loaded]);
  if (!artist.data || artist.isPlaceholderData || !context) {
    return <PageState loading={!artist.isError} message={artist.isError ? loadFailure(artist.error).description : undefined}
      onRetry={artist.isError ? () => void artist.refetch() : undefined} />;
  }
  const data = artist.data;
  return <SongList title="Top Songs" credit={data.name} tracks={data.topTracks} context={context}
    art={<CollectionArt artworks={[data.image]} circle size={artSize} />} tint={data.image?.color} />;
}

function HomeSongs({ sectionId }: { sectionId: string }) {
  const home = useHome();
  const section = home.data?.sections.find((item): item is Extract<HomeSection, { kind: 'tracks' }> => item.kind === 'tracks' && item.id === sectionId);
  const context = useMemo((): PlaybackContext | null => (section ? { type: 'other', id: section.id, title: section.title } : null), [section]);
  if (!section || !context) {
    return <PageState loading={!home.data && !home.isError} message={home.isError ? loadFailure(home.error).description : home.data ? 'Nothing here yet.' : undefined}
      onRetry={home.isError ? () => void home.refetch() : undefined} />;
  }
  return <SongList title={section.title} credit="From Home" tracks={section.tracks} context={context}
    art={<CollectionArt artworks={section.tracks.slice(0, 8).map(track => track.album?.artwork)} size={artSize} />} />;
}

function SongList({ title, credit, tracks, context, art, tint }: {
  title: string; credit: string; tracks: readonly TrackSummary[]; context: PlaybackContext; art: ReactElement; tint?: string | null;
}) {
  const actions = usePlaybackActions();
  const { canPlay } = useAvailability();
  const play = useCallback((shuffle: boolean, start?: number) => actions.playTracks(tracks, { start, shuffle, context }), [actions, context, tracks]);
  const onPlay = useCallback((index: number) => play(false, index), [play]);
  const playable = tracks.some(canPlay);
  return <TrackListPage art={art} tint={tint} title={title} credit={credit}
    facts={tracks.length ? songCountLabel(tracks.length, { durationMs: tracks.reduce((sum, track) => sum + track.durationMs, 0), separator: ', ' }) : undefined}
    buttons={tracks.length > 0 && <>
      <SystemButton label="Play" icon="play.fill" prominent disabled={!playable} onPress={() => play(false)} />
      <SystemButton icon="shuffle" accessibilityLabel="Shuffle" disabled={!playable} onPress={() => play(true)} />
    </>}
    tracks={tracks} onPlay={onPlay} />;
}
