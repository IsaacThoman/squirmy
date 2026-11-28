import { positionAt, type Session } from '@squirmy/client-core'
import type { WebhookEventType } from '@squirmy/contracts'
import { emitWebhook } from './webhooks.js'

export function playbackState(session: Session) {
  if (!session.current || !session.activeDeviceId || (!session.playing && session.current.durationMs > 0 && session.positionMs >= session.current.durationMs)) return 'stopped'
  return session.playing ? (session.stalled ? 'buffering' : 'playing') : 'paused'
}

export function emitPlaybackWebhook(userId: string, previous: Session, next: Session, now: number): void {
  const before = playbackState(previous)
  const after = playbackState(next)
  const events: WebhookEventType[] = []
  if (previous.current?.id !== next.current?.id && next.current) events.push('playback.track_changed')
  if (before !== after) {
    if (after === 'playing') events.push('playback.started')
    else if (after === 'paused' && (before === 'playing' || before === 'buffering')) events.push('playback.paused')
    else if (after === 'stopped') events.push('playback.stopped')
  }
  if (!events.length) return
  const data = {
    deviceId: next.activeDeviceId ?? previous.activeDeviceId,
    trackId: next.current?.trackId ?? null,
    albumId: next.current?.albumId ?? null,
    positionMs: positionAt(next, now),
    state: after,
  }
  void (async () => {
    for (const event of events) await emitWebhook(event, data, userId)
  })()
}
