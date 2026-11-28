/**
 * Anything the browse screens show as a tile or row, and how each kind of thing becomes one.
 * Plain data, so it is shared by the phone and TV screens and tested without React Native.
 */
import type { AlbumSummary, ArtistSummary, Artwork, HomeItem, MixSummary, PlaylistSummary, RadioSummary } from '@squirmy/contracts';
import type { Href } from 'expo-router';
import type { Page } from './links';

/** Anything the browse screens show as a tile or row: an album, artist, playlist, or one of the built-in lists. */
export type Collection = {
  key: string;
  kind: 'album' | 'artist' | 'playlist' | 'liked' | 'recent' | 'mix' | 'radio';
  title: string;
  subtitle: string;
  href: Href;
  artwork?: Artwork | null;
  /** A playlist's covers, shown as a mosaic. */
  artworks?: readonly Artwork[];
  special?: 'liked' | 'recent' | 'playlist' | 'mix' | 'radio';
  round?: boolean;
  /** Nothing on it plays for this viewer, or not downloaded while offline: drawn gray, cover and title alike. */
  dim?: boolean;
  /** An album's availability, which `useCollectionDim` reads with the viewer's rights. */
  availability?: AlbumSummary['availability'];
  /** An album's credited artists, for its menu's "Go to artist". */
  artists?: readonly { id: string; name: string; href: Href }[];
  /** `artists` leaves out the artist whose page the tile is on, so its menu names each one left. */
  otherArtists?: boolean;
  /** Pinned to the top of the Library; known only for the Library's own list, whose first page starts with the pins. */
  pinned?: boolean;
};

type Link = (page: Page, id: string) => Href;

export const likedId = 'liked';
export const recentId = 'recent';

/** An album as a tile. Gray when nothing on it plays for anyone; `useCollectionDim` adds what the viewer can't fetch. */
export function albumCollection(album: AlbumSummary, link: Link, subtitle = album.artistCredit): Collection {
  return {
    key: album.id, kind: 'album', title: album.title, subtitle, href: link('album', album.id), artwork: album.artwork,
    dim: album.availability === 'none', availability: album.availability,
    artists: album.artists.map(artist => ({ id: artist.id, name: artist.name, href: link('artist', artist.id) })),
  };
}

/** An artist as a tile. Never gray online: an artist's page lists their music whether or not it is in the library. */
export function artistCollection(artist: ArtistSummary, link: Link): Collection {
  return { key: artist.id, kind: 'artist', title: artist.name, subtitle: 'Artist', href: link('artist', artist.id), artwork: artist.image, round: true };
}

export function playlistCollection(playlist: PlaylistSummary, link: Link): Collection {
  return {
    key: playlist.id, kind: 'playlist', title: playlist.name, subtitle: `Playlist · ${playlist.ownerName}`, href: link('playlist', playlist.id),
    artworks: playlist.artworks, special: 'playlist',
  };
}

export function likedCollection(link: Link): Collection {
  return { key: likedId, kind: 'liked', title: 'Liked Songs', subtitle: 'Playlist', href: link('playlist', likedId), special: 'liked' };
}

/** A mix made for the user (Home's Made for you): its covers as a mosaic; it opens as a page of its songs. */
export function mixCollection(mix: MixSummary, link: Link): Collection {
  return {
    key: mix.id, kind: 'mix', title: mix.name, subtitle: mix.description, href: link('songs', `mix~${mix.id}`),
    artworks: mix.artworks, special: 'mix',
  };
}

/** A radio the user played (Home's Jump back in). It opens the artist it started from, or its song's album. */
export function radioCollection(radio: RadioSummary, link: Link): Collection {
  return {
    key: `radio:${radio.seed}:${radio.id}`, kind: 'radio', title: `${radio.title} Radio`, subtitle: radio.subtitle ? `Radio · ${radio.subtitle}` : 'Radio',
    href: radio.seed === 'artist' ? link('artist', radio.id) : radio.albumId ? link('album', radio.albumId) : link('songs', `home~jump-back-in`),
    round: radio.seed === 'artist', ...(radio.artwork ? { artwork: radio.artwork } : { special: 'radio' as const }),
  };
}

/** A card of a Home rail of several kinds (Jump back in, Made for you) as a tile. */
export function homeItemCollection(item: HomeItem, link: Link): Collection | null {
  switch (item.kind) {
    case 'album': return albumCollection(item.album, link);
    case 'artist': return artistCollection(item.artist, link);
    case 'playlist': return playlistCollection(item.playlist, link);
    case 'liked': return likedCollection(link);
    case 'mix': return mixCollection(item.mix, link);
    case 'radio': return radioCollection(item.radio, link);
    // A kind from a newer server than this app.
    default: return null;
  }
}

export function recentCollection(link: Link): Collection {
  return { key: recentId, kind: 'recent', title: 'Recently Played', subtitle: 'Listening history', href: link('playlist', recentId), special: 'recent' };
}
