import type { LyricWord } from '@squirmy/contracts';
import { useWordsStarted } from '../playback';
import { LyricButton } from './Controls';
import type { LyricButtonProps } from './Controls';

/**
 * The sung line of lyrics that time their words: lit word by word as each starts. Only this
 * line follows the words; the page and the other lines re-render once a line, as before.
 */
export function SungLyricButton({ words, ...props }: Omit<LyricButtonProps, 'words' | 'sung'> & { words: readonly LyricWord[] }) {
  const sung = useWordsStarted(words, props.active);
  return <LyricButton {...props} words={words} sung={sung} />;
}
