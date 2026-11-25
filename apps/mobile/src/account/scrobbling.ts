import { LastFmOutcome, type ScrobbleService, type ScrobbleTarget } from '@squirmy/contracts';

export const serviceNames: Record<ScrobbleTarget, string> = { listenbrainz: 'ListenBrainz', lastfm: 'Last.fm' };

export const lastFmNote = 'Plays are sent once you have listened to half a song or four minutes of it.';

/** A line about a scrobbling service: who it is connected as, or what is wrong. */
export function scrobbleDetail(service: ScrobbleService): string {
  if (!service.connected) return service.available ? 'Not connected' : 'Not set up on this server';
  if (service.needsAttention) return `${service.account ?? 'Your account'} needs to be connected again`;
  if (service.lastError) return service.lastError;
  const queued = service.pending ? ` · ${service.pending.toLocaleString()} waiting` : '';
  const failed = service.failed ? ` · ${service.failed.toLocaleString()} not sent` : '';
  return `Connected as ${service.account ?? 'you'}${queued}${failed}`;
}

/**
 * The note under a service's controls. `enabled` is the user's switch for it, which may be off
 * while connected: then nothing is sent, and plays from that time never are.
 */
export function scrobbleFooter(service: ScrobbleService, enabled: boolean): string {
  const connected = service.connected && !service.needsAttention;
  if (connected && !enabled) return `Scrobbling is off. Songs you play while it’s off aren’t sent to ${serviceNames[service.target]}.`;
  if (service.target === 'lastfm') return lastFmNote;
  return connected ? 'Your plays are sent to ListenBrainz.' : 'Paste the user token from your ListenBrainz settings page.';
}

/** What disconnecting asks first, as the web app does: unsent plays go with the connection. */
export function disconnectConfirmation(target: ScrobbleTarget): { title: string; message: string } {
  return {
    title: `Disconnect ${serviceNames[target]}?`,
    message: 'Songs you play from now on aren’t sent. Plays still waiting to be sent are dropped.',
  };
}

/** What the screen says when the Last.fm approval returns without connecting. */
const lastFmReturns: Record<Exclude<LastFmOutcome, 'connected'>, string> = {
  denied: 'Last.fm wasn’t connected. The connection wasn’t approved.',
  invalid_state: 'That Last.fm link expired. Connect again.',
  error: 'Last.fm didn’t answer. Try again in a moment.',
};

/**
 * The failure a Last.fm approval returned to the app with (`<returnTo>?lastfm=<outcome>`), or
 * null when it connected or said nothing the app knows.
 */
export function lastFmReturnFailure(url: string): string | null {
  const outcome = LastFmOutcome.safeParse(/[?&]lastfm=([^&#]*)/.exec(url)?.[1]);
  return outcome.success && outcome.data !== 'connected' ? lastFmReturns[outcome.data] : null;
}
