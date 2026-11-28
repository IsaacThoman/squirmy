import { albumTypeLabel, artistAvailabilityNote, canFetch, plural } from '@squirmy/client-core';
import type { AlbumSummary, ArtistDetail, Artwork as ArtworkInfo, PlaybackContext, TrackSummary } from '@squirmy/contracts';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useCallback, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Animated, FlatList, StyleSheet, Text, View } from 'react-native';
import { useSignedInApi } from '../../account/AccountProvider';
import { releaseGroups } from '../../data/artists';
import { useArtworkImage } from '../../data/artwork';
import { loadFailure } from '../../data/errors';
import { useLibraryActions, useLiked, useLikeFailure } from '../../data/library';
import { useArtist } from '../../data/queries';
import { useAvailability } from '../../downloads/DownloadsProvider';
import { heartButton } from '../../library/heart';
import { pageHref } from '../../library/links';
import { useStartGuard } from '../../library/pending';
import { albumCollection, artistCollection, useCollectionDim, type Collection } from '../../library/shared';
import { radioStartingNotice } from '../../library/trackActionList';
import { usePlaybackActions } from '../../playback';
import { playbackStatus } from '../../player/usePlaybackStatus';
import { Artwork } from '../Artwork';
import { SystemButton } from '../Button';
import { CollectionLockup } from '../CollectionLockup';
import { Focusable } from '../Focusable';
import { Menu } from '../Menu';
import { useCollectionMenu } from '../menus';
import { Backdrop, PageState } from '../Page';
import { useNavigate } from '../routes';
import { compactCardHeight, SongCard } from '../screens/ResultCard';
import { Shelf } from '../Shelf';
import { colors, tv, type } from '../theme';
import { latestRelease, shelfLimit, topRow, type TopRowItem } from './artistShelves';
import { releasesId, songsId } from './pageIds';
import { releaseTile } from './releaseTile';
import { SeeAllTile } from './SeeAllTile';

/** Where the name sits over the artist's picture, as the system's music app sets it. */
const heroHeight = 730;
const plainHeroHeight = 420;
const cardWidth = 560;
const rowGap = 40;
const topRowHeight = compactCardHeight * 2 + rowGap;

/**
 * An artist, as the system's music app lays one out: their picture across the screen with the
 * name over it, Play (their top songs), Shuffle, a radio and the heart; then their newest
 * release beside their top songs, their discography a shelf per heading, similar artists, and
 * About. The picture blurs behind the shelves as the page scrolls. An artist the server is
 * still filling in is asked for again until it is done, as on the phone.
 */
export function ArtistPage({ id }: { id: string }) {
  const artist = useArtist(id);
  if (!artist.data) {
    if (artist.isError) return <PageState message={loadFailure(artist.error).description} onRetry={() => void artist.refetch()} />;
    return <PageState loading />;
  }
  return <ArtistBody artist={artist.data} placeholder={artist.isPlaceholderData} />;
}

function ArtistBody({ artist, placeholder }: { artist: ArtistDetail; placeholder: boolean }) {
  const api = useSignedInApi();
  const actions = usePlaybackActions();
  const { canPlay, offline, viewer } = useAvailability();
  const liked = useLiked('artist', artist.id, artist.liked);
  const likeFailure = useLikeFailure('artist', artist.id);
  const { setLiked } = useLibraryActions();
  const starts = useStartGuard();
  const { tab, open } = useNavigate();
  const menu = useCollectionMenu();
  const dim = useCollectionDim();
  const link = useCallback((page: Parameters<typeof pageHref>[1], to: string) => pageHref(tab, page, to), [tab]);
  const scroll = useRef(new Animated.Value(0)).current;
  const top = artist.topTracks;
  const groups = useMemo(() => releaseGroups(artist), [artist]);
  const latest = useMemo(() => latestRelease(groups), [groups]);
  const row = useMemo(() => topRow(latest, top), [latest, top]);
  const context = useMemo((): PlaybackContext => ({ type: 'artist', id: artist.id, title: artist.name }), [artist.id, artist.name]);
  const play = useCallback((shuffle: boolean, start?: number) => actions.playTracks(top, { start, shuffle, context }), [actions, context, top]);
  const playable = top.some(canPlay);
  // Only when the server says a radio starts for this viewer; an older server does not say, and then the library decides.
  const radioOffered = !placeholder && !offline && (artist.radio ?? (artist.inLibrary || canFetch(viewer)));
  const radio = () => {
    if (!api) return;
    starts.run('radio', () => {
      const starting = playbackStatus.report(radioStartingNotice);
      return api.radio.artist(artist.id).then(answer => {
        playbackStatus.withdraw(starting);
        actions.playRadio(answer);
      }, () => playbackStatus.report({ message: `Couldn’t start a radio for ${artist.name}` }));
    });
  };
  const heart = heartButton(liked, artist.name, likeFailure);
  const facts = [artist.disambiguation, ...artist.genres.slice(0, 2), !placeholder && artistAvailabilityNote(artist, viewer)].filter(Boolean).join(' · ');
  const hasImage = Boolean(artist.image);

  return <View style={styles.page}>
    {hasImage ? <ArtistBackdrop image={artist.image!} scroll={scroll} /> : <Backdrop />}
    <Animated.ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
      scrollEventThrottle={16}
      onScroll={Animated.event([{ nativeEvent: { contentOffset: { y: scroll } } }], { useNativeDriver: true })}
    >
      <View style={[styles.hero, { height: hasImage ? heroHeight : plainHeroHeight }]}>
        <Text accessibilityRole="header" style={styles.name} numberOfLines={2}>{artist.name}</Text>
        {facts ? <Text style={styles.facts} numberOfLines={1}>{facts}</Text> : null}
        <View style={styles.buttons}>
          {playable && <SystemButton label="Play" icon="play.fill" prominent onPress={() => play(false)} />}
          {playable && <SystemButton icon="shuffle" accessibilityLabel="Shuffle" onPress={() => play(true)} />}
          {radioOffered && (playable
            ? <SystemButton icon="dot.radiowaves.left.and.right" accessibilityLabel={`Start a radio for ${artist.name}`} onPress={radio} />
            : <SystemButton label="Start radio" icon="dot.radiowaves.left.and.right" prominent onPress={radio} />)}
          {!placeholder && <SystemButton icon={heart.icon} tint={heart.failed ? colors.danger : heart.selected ? colors.accent : undefined}
            accessibilityLabel={heart.label} onPress={() => setLiked('artist', artist.id, !liked, artist.name)} />}
        </View>
      </View>
      {placeholder ? <ActivityIndicator style={styles.loading} color={colors.secondary} /> : <>
        {row.length > 0 && <TopRow items={row} top={top} onPlay={start => play(false, start)}
          onSeeAll={() => open('songs', songsId('top', artist.id))} onOpenAlbum={albumId => open('album', albumId)} link={link} />}
        {groups.map(group => {
          const items = group.albums.slice(0, shelfLimit).map(album => dim(releaseTile(album, group.key, link, artist.id)));
          const more = (group.paged ? group.total : group.albums.length) > items.length;
          return <Shelf<Collection | null> key={group.key} title={group.title} items={more ? [...items, null] : items}
            keyOf={item => item?.key ?? 'see-all'}
            render={item => item ? <CollectionLockup item={item} menu={menu} />
              : <SeeAllTile size={tv.tile} onPress={() => open('releases', releasesId(artist.id, group.key))} />} />;
        })}
        {artist.similar.length > 0 && <Shelf title="Similar Artists" items={artist.similar.map(similar => artistCollection(similar, link))}
          keyOf={item => item.key} render={item => <CollectionLockup item={item} menu={menu} size={220} />} />}
        {artist.bio ? <About name={artist.name} bio={artist.bio} /> : null}
        {!top.length && !groups.length && !artist.similar.length && <Text style={styles.note}>
          {artist.detailPending ? 'Still gathering this artist’s music…' : 'The server has no music by this artist yet.'}
        </Text>}
      </>}
    </Animated.ScrollView>
  </View>;
}

/**
 * The artist's picture across the screen, darkened toward the page so the name and shelves
 * over it stay legible; as the page scrolls it blurs, as the system's artist pages do.
 */
function ArtistBackdrop({ image, scroll }: { image: ArtworkInfo; scroll: Animated.Value }) {
  const sharp = useArtworkImage(image, 1920);
  const blurred = useArtworkImage(image, 480);
  const blur = scroll.interpolate({ inputRange: [0, 420], outputRange: [0, 1], extrapolate: 'clamp' });
  return <View style={StyleSheet.absoluteFill} pointerEvents="none">
    <View style={[StyleSheet.absoluteFill, { backgroundColor: image.color ?? colors.background }]} />
    {sharp && <Image source={sharp.source} placeholder={sharp.placeholder} contentFit="cover" contentPosition="top" transition={200}
      cachePolicy="memory-disk" style={StyleSheet.absoluteFill} />}
    {blurred && <Animated.View style={[StyleSheet.absoluteFill, { opacity: blur }]}>
      <Image source={blurred.source} contentFit="cover" contentPosition="top" blurRadius={40} cachePolicy="memory-disk" style={StyleSheet.absoluteFill} />
      <View style={[StyleSheet.absoluteFill, styles.dimmer]} />
    </Animated.View>}
    <LinearGradient colors={['rgba(0,0,0,0)', 'rgba(0,0,0,0.25)', 'rgba(10,9,14,0.92)']} locations={[0.3, 0.55, 1]} style={StyleSheet.absoluteFill} />
    <LinearGradient colors={['rgba(0,0,0,0.55)', 'rgba(0,0,0,0)']} start={{ x: 0, y: 0 }} end={{ x: 0.6, y: 0 }} style={StyleSheet.absoluteFill} />
  </View>;
}

/** The newest release beside the top songs, two to a column, as one row that scrolls sideways. */
function TopRow({ items, top, onPlay, onSeeAll, onOpenAlbum, link }: {
  items: TopRowItem[]; top: readonly TrackSummary[]; onPlay: (start: number) => void; onSeeAll: () => void;
  onOpenAlbum: (id: string) => void; link: (page: Parameters<typeof pageHref>[1], id: string) => ReturnType<typeof pageHref>;
}) {
  const { toggleIfCurrent } = usePlaybackActions();
  const render = useCallback(({ item }: { item: TopRowItem }) => {
    switch (item.kind) {
      case 'latest': return <View>
        <Text style={styles.rowTitle}>Latest Release</Text>
        <LatestCard album={item.album} collection={albumCollection(item.album, link)} onPress={() => onOpenAlbum(item.album.id)} />
      </View>;
      case 'songs': return <View>
        <Text style={styles.rowTitle}>{item.first ? 'Top Songs' : ' '}</Text>
        <View style={styles.songColumn}>
          {item.tracks.map((track, index) => <SongCard key={track.id} track={track} compact width={cardWidth}
            subtitle={track.album ? track.album.title : track.artistCredit}
            // The song playing (or paused) pauses or resumes rather than starting over, as its row does.
            onPress={() => { if (!toggleIfCurrent(track.id)) onPlay(item.start + index); }} />)}
        </View>
      </View>;
      case 'all': return <View>
        <Text style={styles.rowTitle}> </Text>
        <SeeAllTile size={200} height={topRowHeight} onPress={onSeeAll} label={`All ${plural(top.length, 'song')}`} />
      </View>;
    }
  }, [link, onOpenAlbum, onPlay, onSeeAll, toggleIfCurrent, top.length]);
  return <View style={styles.topRow}>
    <FlatList horizontal data={items} renderItem={render} keyExtractor={item => item.key} showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.topRowContent} style={styles.visible} removeClippedSubviews={false} />
  </View>;
}

/** The newest release as a wide card: its cover, when it came out, its title and how many songs. */
function LatestCard({ album, collection, onPress }: { album: AlbumSummary; collection: Collection; onPress: () => void }) {
  const menu = useCollectionMenu()(collection);
  return <Menu actions={menu.actions} onAction={menu.onAction} title={album.title}>
    <Focusable accessibilityLabel={`Latest release, ${album.title}`} onPress={onPress} scale={1.04} liftStyle={styles.latestLift}>
      {({ focused }) => <View style={[styles.latest, focused && styles.latestFocused]}>
        <Artwork artwork={album.artwork} size={topRowHeight} radius={0} focusEffect={false} dim={collection.dim} />
        <View style={styles.latestWords}>
          {album.year ? <Text style={styles.latestYear}>{album.year}</Text> : null}
          <Text style={styles.latestTitle} numberOfLines={2}>{album.title}</Text>
          <Text style={styles.latestFacts} numberOfLines={1}>{[albumTypeLabel(album.type), album.trackCount ? plural(album.trackCount, 'song') : null].filter(Boolean).join(' · ')}</Text>
        </View>
      </View>}
    </Focusable>
  </Menu>;
}

/** The biography, a few lines of it; choosing it shows all of it, and again fewer. */
function About({ name, bio }: { name: string; bio: string }) {
  const [open, setOpen] = useState(false);
  return <View style={styles.about}>
    <Text style={styles.aboutTitle}>About</Text>
    <Focusable accessibilityLabel={`About ${name}`} accessibilityHint={open ? 'Shows less' : 'Shows the whole biography'} onPress={() => setOpen(!open)}
      scale={1.02} liftStyle={({ focused }) => [styles.aboutCard, focused && styles.aboutFocused]}>
      <Text style={styles.bio} numberOfLines={open ? undefined : 4}>{bio}</Text>
    </Focusable>
  </View>;
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.background },
  scroll: { flex: 1, overflow: 'visible' },
  content: { paddingBottom: 120 },
  visible: { overflow: 'visible' },
  hero: { justifyContent: 'flex-end', paddingHorizontal: tv.gutter, paddingBottom: 30 },
  name: { ...type.largeTitle, fontWeight: '800', letterSpacing: -1, textShadowColor: 'rgba(0,0,0,0.35)', textShadowRadius: 18 },
  facts: { ...type.callout, color: 'rgba(255,255,255,0.78)', marginTop: 6 },
  buttons: { flexDirection: 'row', alignItems: 'center', gap: 24, marginTop: 28 },
  loading: { marginTop: 40 },
  note: { ...type.body, color: colors.secondary, marginHorizontal: tv.gutter, marginTop: 20 },
  dimmer: { backgroundColor: 'rgba(10,9,14,0.45)' },
  topRow: { marginBottom: tv.shelfGap, marginTop: -20 },
  topRowContent: { paddingHorizontal: tv.gutter, gap: rowGap, paddingVertical: 20 },
  rowTitle: { ...type.section, marginBottom: 22 },
  songColumn: { gap: rowGap },
  latestLift: { borderRadius: 18 },
  latest: { width: cardWidth, height: topRowHeight, flexDirection: 'row', borderRadius: 18, overflow: 'hidden', backgroundColor: colors.platter },
  latestFocused: { backgroundColor: 'rgba(255,255,255,0.26)' },
  latestWords: { flex: 1, justifyContent: 'center', paddingHorizontal: 24, gap: 6 },
  latestYear: { ...type.caption },
  latestTitle: { ...type.headline, fontSize: 34 },
  latestFacts: { ...type.subhead },
  about: { marginHorizontal: tv.gutter, marginBottom: tv.shelfGap },
  aboutTitle: { ...type.section, marginBottom: 22 },
  aboutCard: { maxWidth: 1300, padding: 32, borderRadius: 18, backgroundColor: colors.platter },
  aboutFocused: { backgroundColor: 'rgba(255,255,255,0.22)' },
  bio: { ...type.body, color: colors.text, lineHeight: 42 },
});
