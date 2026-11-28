import type {
  AlbumDetail, AlbumSummary, ArtistDetail, ArtistSummary, HistoryItem, HomeSection, LibraryItem, Page, PlaylistDetail, PlaylistSummary,
  TrackSummary,
} from '@squirmy/contracts';
import type { LocalLibrary } from './localSearch';

/** A query in the cache: its key and the data it holds. */
export type CachedQuery = { queryKey: readonly unknown[]; data: unknown };

/** What the downloads index keeps: every track it lists, and the albums and playlists downloaded whole, as last seen. */
export type KeptDownloads = {
  tracks: readonly TrackSummary[];
  albums: readonly Omit<AlbumDetail, 'discs'>[];
  playlists: readonly PlaylistSummary[];
};

/** The items of an infinite query's pages, or none when `data` is not one. */
function pageItems<T>(data: unknown): T[] {
  const pages = (data as { pages?: unknown } | undefined)?.pages;
  return Array.isArray(pages) ? pages.flatMap(page => (page as Page<T>)?.items ?? []) : [];
}

/** An artist page's own summary: the detail carries every field of one. */
const artistOf = (artist: ArtistDetail): ArtistSummary => ({
  id: artist.id, mbid: artist.mbid, name: artist.name, image: artist.image, inLibrary: artist.inLibrary, liked: artist.liked,
});

/** An album page's own summary, without its songs, which are listed as songs. */
function albumOf({ discs: _discs, versions: _versions, ...album }: AlbumDetail): AlbumSummary {
  return album;
}

/**
 * Everything the phone holds to search with no connection: the downloads, then what the saved
 * query cache answered (the Library's lists, Liked Songs, playlists, history, Home, and the
 * album, artist and playlist pages last opened). Each list may name an item more than once;
 * `localSearch` keeps the first, so a download's copy wins.
 *
 * `scope: 'library'` keeps what the Library lists: what it says is in the library, the
 * viewer's playlists and what they downloaded, as the Library's own search does online.
 */
export function localLibrary(queries: readonly CachedQuery[], downloads: KeptDownloads, scope: 'all' | 'library'): LocalLibrary {
  const tracks: TrackSummary[] = [...downloads.tracks];
  const albums: AlbumSummary[] = [...downloads.albums];
  const artists: ArtistSummary[] = [];
  const playlists: PlaylistSummary[] = [...downloads.playlists];
  // What the Library itself lists counts as in it whatever the item says.
  const listed = { albums: new Set<string>(), artists: new Set<string>() };

  for (const { queryKey, data } of queries) {
    if (!data) continue;
    const [root, second, third] = queryKey;
    if (root === 'library' && second === 'items') {
      for (const item of pageItems<LibraryItem>(data)) {
        if (item.kind === 'album') { albums.push(item.album); listed.albums.add(item.album.id); }
        if (item.kind === 'artist') { artists.push(item.artist); listed.artists.add(item.artist.id); }
        if (item.kind === 'playlist') playlists.push(item.playlist);
      }
    } else if (root === 'library' && third === 'list') {
      if (second === 'albums') for (const album of pageItems<AlbumSummary>(data)) { albums.push(album); listed.albums.add(album.id); }
      if (second === 'artists') for (const artist of pageItems<ArtistSummary>(data)) { artists.push(artist); listed.artists.add(artist.id); }
      if (second === 'tracks') tracks.push(...pageItems<TrackSummary>(data));
    } else if (root === 'likes' && second === 'track') {
      tracks.push(...pageItems<TrackSummary>(data));
    } else if (root === 'playlists' && second === 'list') {
      playlists.push(...pageItems<PlaylistSummary>(data));
    } else if (root === 'playlists' && typeof second === 'string' && queryKey.length === 2) {
      const { items, ...playlist } = data as PlaylistDetail;
      playlists.push(playlist);
      tracks.push(...(items ?? []).map(item => item.track));
    } else if (root === 'history' && queryKey.length === 1) {
      tracks.push(...pageItems<HistoryItem>(data).map(item => item.track));
    } else if (root === 'home') {
      for (const section of (data as { sections?: HomeSection[] }).sections ?? []) {
        if (section.kind === 'tracks') tracks.push(...section.tracks);
        if (section.kind === 'albums') albums.push(...section.albums);
        if (section.kind === 'artists') artists.push(...section.artists);
        if (section.kind === 'playlists') playlists.push(...section.playlists);
      }
    } else if (root === 'album' && queryKey.length === 2) {
      const album = data as AlbumDetail;
      albums.push(albumOf(album));
      tracks.push(...(album.discs ?? []).flatMap(disc => disc.tracks));
    } else if (root === 'artist' && queryKey.length === 2) {
      const artist = data as ArtistDetail;
      artists.push(artistOf(artist));
      tracks.push(...(artist.topTracks ?? []));
    }
  }

  if (scope === 'all') return { tracks, albums, artists, playlists };
  const kept = new Set(downloads.tracks.map(track => track.id));
  const keptAlbums = new Set(downloads.albums.map(album => album.id));
  return {
    // An older server does not say whether a song is in the library; then it is kept, as online.
    tracks: tracks.filter(track => kept.has(track.id) || track.inLibrary !== false),
    albums: albums.filter(album => keptAlbums.has(album.id) || listed.albums.has(album.id) || album.liked === true
      // An album page says whether the album is in the library.
      || (album as Partial<Pick<AlbumDetail, 'library'>>).library != null),
    artists: artists.filter(artist => listed.artists.has(artist.id) || artist.inLibrary),
    playlists,
  };
}
