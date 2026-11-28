import { canFetch } from '@squirmy/client-core';
import type { HomeSection, TrackSummary } from '@squirmy/contracts';
import { useCallback, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useAccount, useWantlistEnabled } from '../../account/AccountProvider';
import { loadFailure } from '../../data/errors';
import { useHome } from '../../data/queries';
import { useScanProgress } from '../../data/realtime';
import { useCanPlay, useViewer } from '../../downloads/DownloadsProvider';
import { homeEmpty } from '../../library/homeEmpty';
import { pageHref } from '../../library/links';
import { albumCollection, artistCollection, homeItemCollection, playlistCollection, useCollectionDim, type Collection } from '../../library/shared';
import { usePlaybackActions } from '../../playback';
import { Icon } from '../../ui';
import { CollectionLockup } from '../CollectionLockup';
import { Lockup } from '../Lockup';
import { Menu } from '../Menu';
import { useCollectionMenu, useOpenPage, useTrackMenu } from '../menus';
import { EmptyMessage, Page, PageState } from '../Page';
import { Shelf } from '../Shelf';
import { TabRoot } from '../Sidebar';
import { colors, tv } from '../theme';
import { useFirstFocus } from './useFirstFocus';

/** The first shelf is larger, as the system's music app leads with its top picks. */
const heroSize = 400;

function sectionSize(section: HomeSection) {
  switch (section.kind) {
    case 'albums': return section.albums.length;
    case 'artists': return section.artists.length;
    case 'tracks': return section.tracks.length;
    case 'playlists': return section.playlists.length;
    case 'items': return section.items.length;
    // A kind from a newer server than this app shows nothing.
    default: return 0;
  }
}

/** Home: what you played, your playlists, what is new on the server, as shelves of covers. */
export function HomeScreen() {
  const home = useHome();
  const wantlist = useWantlistEnabled();
  const { state } = useAccount();
  const viewer = useViewer();
  const scan = useScanProgress();
  const menu = useCollectionMenu();
  const dim = useCollectionDim();
  const link = useCallback((page: Parameters<typeof pageHref>[1], id: string) => pageHref('home', page, id), []);
  const sections = useMemo(() => (home.data?.sections ?? []).filter(section => sectionSize(section) > 0 && (wantlist || section.id !== 'wantlist')), [home.data, wantlist]);
  const first = useFirstFocus();

  // A tab's first screen, so Menu opens the sidebar over its loading and its error too.
  if (!home.data) {
    return <TabRoot>{home.isError
      ? <PageState message={loadFailure(home.error).description} onRetry={() => void home.refetch()} />
      : <PageState loading />}</TabRoot>;
  }
  if (!sections.length) {
    const empty = homeEmpty({ canFindMusic: canFetch(viewer), isAdmin: state.status === 'signedIn' && state.user.role === 'admin', scan });
    return <Page>
      <EmptyMessage icon={<Icon name={empty.icon} size={96} color={colors.secondary} />} title={empty.title} description={empty.description} />
    </Page>;
  }
  const heroIndex = sections.findIndex(section => section.kind === 'albums' || section.kind === 'playlists' || section.kind === 'items');
  return <Page onFocusCapture={first.onFocusCapture}>
    {sections.map((section, index) => {
      const hero = index === heroIndex;
      const collections: Collection[] | null = section.kind === 'albums' ? section.albums.map(album => dim(albumCollection(album, link)))
        : section.kind === 'artists' ? section.artists.map(artist => artistCollection(artist, link))
          : section.kind === 'playlists' ? section.playlists.map(playlist => playlistCollection(playlist, link))
            : section.kind === 'items' ? section.items.flatMap(item => homeItemCollection(item, link) ?? []).map(dim) : null;
      if (collections) {
        return <Shelf key={section.id} title={section.title} items={collections} keyOf={item => item.key} lift={hero ? 60 : 40}
          render={(item, at) => <CollectionLockup item={item} menu={menu} size={hero ? heroSize : section.kind === 'artists' ? 220 : tv.tile}
            hasTVPreferredFocus={first.preferred && hero && at === 0} />} />;
      }
      if (section.kind === 'tracks') return <SongShelf key={section.id} title={section.title} id={section.id} tracks={section.tracks} />;
      return null;
    })}
    {home.isFetching && !home.isLoading ? null : <View style={styles.end} />}
  </Page>;
}

/** Songs as covers: choosing one plays the shelf from it. */
function SongShelf({ title, id, tracks }: { title: string; id: string; tracks: TrackSummary[] }) {
  const actions = usePlaybackActions();
  return <Shelf title={title} items={tracks} keyOf={track => track.id}
    render={(track, index) => <SongTile track={track} onPlay={() => actions.playTracks(tracks, { start: index, context: { type: 'other', id, title } })} />} />;
}

/**
 * A song as a cover. As a song's row does on the phone, choosing the one playing (or paused)
 * pauses or resumes it rather than starting it over, and one that can't play opens its album.
 */
function SongTile({ track, onPlay }: { track: TrackSummary; onPlay: () => void }) {
  const playable = useCanPlay(track);
  const { toggleIfCurrent } = usePlaybackActions();
  const openPage = useOpenPage();
  const { actions, onAction } = useTrackMenu(track);
  const press = () => {
    if (toggleIfCurrent(track.id)) return;
    if (playable) onPlay();
    else if (track.album) openPage('album', track.album.id);
  };
  return <Menu actions={actions} onAction={onAction} title={track.title}>
    <Lockup artwork={track.album?.artwork} title={track.title} subtitle={track.artistCredit} badge={track.explicit ? 'E' : undefined}
      dim={!playable} onPress={press} />
  </Menu>;
}

const styles = StyleSheet.create({
  end: { height: 1 },
});

