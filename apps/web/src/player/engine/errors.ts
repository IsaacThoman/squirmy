/** The engine's error message when the browser's autoplay policy refused to start audio. */
export const AUDIO_BLOCKED_MESSAGE = 'The browser blocked audio until you click or press a key on the page'

/** `MediaError.code` in words, or null for an abort, which the engine causes itself. */
export function mediaErrorMessage(code: number | undefined): string | null {
  switch (code) {
    case 1: return null
    case 2: return 'The audio stopped downloading'
    case 3: return 'The audio could not be decoded'
    case 4: return 'The audio could not be loaded: the file is missing, its link expired, or the browser cannot play its format'
    default: return 'The audio could not be played'
  }
}

/**
 * Why `HTMLMediaElement.play()` rejected: the autoplay policy (`blocked`), a pause or new
 * source that interrupted it (`aborted`, harmless), or the media itself (`failed`).
 */
export function playFailure(error: unknown): 'blocked' | 'aborted' | 'failed' {
  const name = (error as { name?: unknown } | null)?.name
  if (name === 'NotAllowedError') return 'blocked'
  if (name === 'AbortError') return 'aborted'
  return 'failed'
}

/** Clamps to [0, duration] in milliseconds; the upper bound applies once the duration is known. */
export function clampPosition(positionMs: number, durationSeconds: number): number {
  const position = Math.max(0, positionMs)
  return Number.isFinite(durationSeconds) ? Math.min(position, Math.round(durationSeconds * 1000)) : position
}
