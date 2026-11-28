import { releaseSubtitle } from '@squirmy/client-core';
import type { AlbumSummary } from '@squirmy/contracts';
import { appearsOnKey } from '../../data/artists';
import { besideArtist } from '../../library/collectionMenu';
import type { Page } from '../../library/links';
import { albumCollection } from '../../library/shared';
import type { Href } from 'expo-router';

/**
 * A release tile on an artist's pages, as the phone draws it: its year and type, or for another
 * artist's release its year and who made it. The year leads, so a long credit cut short does
 * not take it. Its menu names only the album's other artists.
 */
export function releaseTile(album: AlbumSummary, group: string, link: (page: Page, id: string) => Href, artistId: string) {
  const subtitle = group === appearsOnKey ? [album.year, album.artistCredit].filter(Boolean).join(' · ') : releaseSubtitle(album);
  return besideArtist(albumCollection(album, link, subtitle), artistId);
}
