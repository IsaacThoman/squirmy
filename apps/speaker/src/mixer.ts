import { execFile } from 'node:child_process'

/**
 * Turns an ALSA mixer control for the session's volume, so the samples reach the DAC unscaled
 * and its own (often analog) volume does the work. One `amixer` runs at a time; the latest
 * volume wins.
 */
export function alsaMixer(control: string, card: string | undefined, onLog: (message: string, error?: unknown) => void) {
  let running = false
  let wanted: number | null = null
  let applied: number | null = null
  const next = () => {
    if (running || wanted === null || wanted === applied) return
    const percent = wanted
    running = true
    // -M maps the percentage to how loud it sounds, as desktop volume sliders do.
    execFile('amixer', ['-q', '-M', ...(card ? ['-c', card] : []), 'sset', control, `${percent}%`], error => {
      running = false
      if (error) onLog(`Could not set the ${control} mixer control`, error)
      else applied = percent
      next()
    })
  }
  return {
    /** Volume from 0 to 1. */
    set(volume: number) {
      wanted = Math.round(Math.max(0, Math.min(1, volume)) * 100)
      next()
    },
  }
}
