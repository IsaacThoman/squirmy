import { useLibraryActions, useLiked, useLikeFailure } from '../data/library';
import { heartButton, type HeartButton } from '../library/heart';
import { usePlaybackState } from '../playback';
import { selectionFeedback } from './design';

/**
 * The playing song's heart, shared by Now Playing and the mini-player so both show the same
 * state. `toggle` does nothing until the song's details load.
 */
export function useCurrentTrackHeart(): { heart: HeartButton; toggle: () => void } {
  const { track } = usePlaybackState();
  const { setLiked } = useLibraryActions();
  const liked = useLiked('track', track?.id, track?.liked);
  const heart = heartButton(liked, track?.title ?? '', useLikeFailure('track', track?.id));
  const toggle = () => {
    if (!track) return;
    selectionFeedback();
    setLiked('track', track.id, !liked, track.title);
  };
  return { heart, toggle };
}
