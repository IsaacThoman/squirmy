import type { ArtSize, Artwork } from '@squirmy/contracts'
import { useEffect } from 'react'
import { doubleSize, rememberLoadedArt, useArtUrl } from '@/lib/artwork'
import type { PlayerState } from '@/player/player-context'

/** The renditions the player draws a cover at: the bar's and mini-player's, and Now Playing's while it is open. */
const barSize: ArtSize = 96
const nowPlayingSize: ArtSize = 1200

/** The cover that comes after the current one: the next in the queue, or Autoplay's when the queue is done. */
export function nextArtwork(state: Pick<PlayerState, 'current' | 'queue' | 'autoplayQueue'>): Artwork | null {
  const current = state.current?.track.album?.artwork?.id
  const next = [...state.queue, ...state.autoplayQueue].find(item => item.track.album?.artwork)?.track.album?.artwork ?? null
  return next && next.id !== current ? next : null
}

/**
 * Loads the next song's cover into the browser's cache before the song starts, at the sizes the
 * player shows it, so the crossfade to it starts at once rather than after a download.
 */
export function usePreloadNextArtwork(state: Pick<PlayerState, 'current' | 'queue' | 'autoplayQueue'>, nowPlayingOpen: boolean) {
  const artUrl = useArtUrl()
  const artwork = nextArtwork(state)
  const id = artwork?.id ?? null
  // The same candidates as `Cover`'s, so the browser picks (and caches) the one it will show; one string, so only a change loads again.
  const sets = artwork
    ? [barSize, ...(nowPlayingOpen ? [nowPlayingSize] : [])].map(size => `${artUrl(artwork, size)} 1x, ${artUrl(artwork, doubleSize(size))} 2x`).join('\n')
    : ''
  useEffect(() => {
    if (!id || !sets) return
    const images = sets.split('\n').map((srcset) => {
      const image = new Image()
      image.decoding = 'async'
      image.onload = () => rememberLoadedArt(id, image.currentSrc)
      image.srcset = srcset
      image.src = srcset.split(' ')[0]!
      return image
    })
    return () => { for (const image of images) image.onload = null }
  }, [id, sets])
}
