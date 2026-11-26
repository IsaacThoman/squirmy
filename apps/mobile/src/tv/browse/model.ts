import type { AlbumSummary, ArtistSectionKey, ArtistSummary, Artwork, HomeSection, LibraryItem, PlaylistSummary, TrackSummary } from '@squirmy/contracts';
import { plural } from '@squirmy/client-core';

export type BrowseRoute =
  | { screen: 'home' | 'library' | 'search' | 'collection' | 'genres' }
  | { screen: 'album' | 'artist' | 'playlist' | 'genre' | 'homeSongs'; id: string }
  | { screen: 'releases'; id: string; group: ArtistSectionKey }
  | { screen: 'track'; track: TrackSummary; album?: string; artist?: string; playlist?: { id: string; itemId: string } }
  | { screen: 'addToPlaylist'; track: TrackSummary };

export type BrowseProps = {
  navigate: (route: BrowseRoute) => void;
  back: () => void;
  active?: boolean;
};

export type Card = {
  key: string;
  title: string;
  subtitle: string;
  route: BrowseRoute;
  artworks?: readonly Artwork[];
  glyph?: string;
  round?: boolean;
  dim?: boolean;
  availability?: AlbumSummary['availability'];
};

export function albumCard(album: AlbumSummary, subtitle = album.artistCredit): Card {
  return {
    key: `album:${album.id}`, title: album.title, subtitle,
    route: { screen: 'album', id: album.id }, artworks: album.artwork ? [album.artwork] : [],
    availability: album.availability,
  };
}

export function artistCard(artist: ArtistSummary): Card {
  return {
    key: `artist:${artist.id}`, title: artist.name, subtitle: 'Artist',
    route: { screen: 'artist', id: artist.id }, artworks: artist.image ? [artist.image] : [], glyph: '♪', round: true,
  };
}

export function playlistCard(playlist: PlaylistSummary): Card {
  return {
    key: `playlist:${playlist.id}`, title: playlist.name, subtitle: plural(playlist.trackCount, 'song'),
    route: { screen: 'playlist', id: playlist.id }, artworks: playlist.artworks, glyph: '♫',
  };
}

export const likedCard: Card = {
  key: 'liked', title: 'Liked Songs', subtitle: 'Playlist', route: { screen: 'playlist', id: 'liked' }, glyph: '♥',
};

export const recentCard: Card = {
  key: 'recent', title: 'Recently Played', subtitle: 'Listening history', route: { screen: 'playlist', id: 'recent' }, glyph: '↺',
};

export function libraryCard(item: LibraryItem): Card {
  switch (item.kind) {
    case 'album': return albumCard(item.album);
    case 'artist': return artistCard(item.artist);
    case 'playlist': return playlistCard(item.playlist);
    case 'liked': return likedCard;
  }
}

export function homeCards(section: HomeSection): Card[] {
  switch (section.kind) {
    case 'albums': return section.albums.map(album => albumCard(album));
    case 'artists': return section.artists.map(artistCard);
    case 'playlists': return section.playlists.map(playlistCard);
    case 'tracks': return [];
  }
}
