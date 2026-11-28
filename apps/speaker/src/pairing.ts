import { ApiError, type createApiClient } from '@squirmy/client-core'
import type { AuthResponse, ClientDevice, TvPairing } from '@squirmy/contracts'
import { setTimeout as sleep } from 'node:timers/promises'

type Api = ReturnType<typeof createApiClient>

/**
 * Signs the speaker in the way an Apple TV signs in: it asks the server for a code, shows it
 * (`onCode`: the log, a QR code, the status page), and polls until someone signed in on a
 * phone or browser approves it at `/pair`. A code that expires is replaced with a new one.
 */
export async function pairSpeaker(api: Api, device: ClientDevice, options: {
  onCode: (pairing: TvPairing) => void
  signal?: AbortSignal
}): Promise<AuthResponse> {
  const status = await api.auth.setupStatus()
  if (!status.supportsSpeakerPairing) throw new Error(`${status.serverName} (Squirmy ${status.version}) cannot pair speakers yet. Update the server.`)
  for (;;) {
    const pairing = await api.auth.startTvPairing({ device: { ...device, kind: 'speaker' } }, { signal: options.signal })
    options.onCode(pairing)
    let interval = pairing.intervalSeconds
    for (;;) {
      await sleep(interval * 1000, undefined, { signal: options.signal })
      try {
        const poll = await api.auth.pollTvPairing({ deviceCode: pairing.deviceCode }, { signal: options.signal })
        if (poll.status === 'approved') return poll.session
        interval = poll.intervalSeconds
      } catch (error) {
        // Expired: start over with a new code. Anything else (no connection) is tried again.
        if (error instanceof ApiError && error.code === 'pairing_unavailable') break
        if (options.signal?.aborted) throw error
        interval = Math.min(60, interval + 5)
      }
    }
  }
}
