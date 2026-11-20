import { artworkUrl } from '@squirmy/client-core';
import type { Artwork } from '@squirmy/contracts';
import type { ImageSource } from 'expo-image';
import { useMemo } from 'react';
import { PixelRatio } from 'react-native';
import { useServerUrl } from '../account/AccountProvider';
import { useKeptArtwork } from '../downloads/DownloadsProvider';
import { useRealtime } from './realtime';

/** The size covers are kept at with downloads. */
const keptSize = 600;

/**
 * The rendition of `artwork` for a view `size` points wide, with its ThumbHash as the
 * placeholder shown until it loads. A cover kept with a download is used when it is sharp
 * enough, or whenever the server cannot be reached. Null without artwork.
 */
export function useArtworkImage(artwork: Artwork | null | undefined, size: number): { source: ImageSource; placeholder?: ImageSource } | null {
  const serverUrl = useServerUrl();
  const kept = useKeptArtwork(artwork?.id);
  const { offline } = useRealtime();
  return useMemo(() => {
    const pixels = size * PixelRatio.get();
    const uri = kept && (offline || pixels <= keptSize) ? kept : artworkUrl(serverUrl, artwork, pixels);
    if (!artwork || !uri) return null;
    return { source: { uri, cacheKey: `${artwork.id}:${uri.slice(uri.lastIndexOf('/') + 1)}` }, placeholder: artwork.thumbhash ? { thumbhash: artwork.thumbhash } : undefined };
  }, [artwork, kept, offline, serverUrl, size]);
}
