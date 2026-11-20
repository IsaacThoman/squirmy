import { artworkUrl } from '@squirmy/client-core';
import type { Artwork } from '@squirmy/contracts';
import type { ImageSource } from 'expo-image';
import { useMemo } from 'react';
import { PixelRatio } from 'react-native';
import { useServerUrl } from '../account/AccountProvider';

/**
 * The rendition of `artwork` for a view `size` points wide, with its ThumbHash as the
 * placeholder shown until it loads. Null without artwork.
 */
export function useArtworkImage(artwork: Artwork | null | undefined, size: number): { source: ImageSource; placeholder?: ImageSource } | null {
  const serverUrl = useServerUrl();
  return useMemo(() => {
    const uri = artworkUrl(serverUrl, artwork, size * PixelRatio.get());
    if (!artwork || !uri) return null;
    return { source: { uri, cacheKey: `${artwork.id}:${uri.slice(uri.lastIndexOf('/') + 1)}` }, placeholder: artwork.thumbhash ? { thumbhash: artwork.thumbhash } : undefined };
  }, [artwork, serverUrl, size]);
}
