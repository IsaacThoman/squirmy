import type { ScrobbleService } from '@squirmy/contracts';
import { describe, expect, it } from 'vitest';
import { disconnectConfirmation, lastFmNote, lastFmReturnFailure, scrobbleDetail, scrobbleFooter } from './scrobbling';

const service = (change: Partial<ScrobbleService> = {}): ScrobbleService => ({
  target: 'listenbrainz', available: true, connected: true, account: 'ada', enabled: true, needsAttention: false,
  lastError: null, connectedAt: '2026-11-20T08:00:00.000Z', pending: 0, failed: 0, ...change,
});

describe('scrobbleDetail', () => {
  it('says who a service is connected as, and what is waiting or was given up on', () => {
    expect(scrobbleDetail(service())).toBe('Connected as ada');
    expect(scrobbleDetail(service({ pending: 3, failed: 1 }))).toBe('Connected as ada · 3 waiting · 1 not sent');
  });

  it('says what is wrong before anything else', () => {
    expect(scrobbleDetail(service({ connected: false }))).toBe('Not connected');
    expect(scrobbleDetail(service({ target: 'lastfm', connected: false, available: false }))).toBe('Not set up on this server');
    expect(scrobbleDetail(service({ needsAttention: true, pending: 2 }))).toBe('ada needs to be connected again');
    expect(scrobbleDetail(service({ lastError: 'ListenBrainz is down' }))).toBe('ListenBrainz is down');
  });
});

describe('scrobbleFooter', () => {
  it('says plays are sent only while the switch is on', () => {
    expect(scrobbleFooter(service(), true)).toBe('Your plays are sent to ListenBrainz.');
    expect(scrobbleFooter(service(), false)).toBe('Scrobbling is off. Songs you play while it’s off aren’t sent to ListenBrainz.');
    expect(scrobbleFooter(service({ target: 'lastfm' }), true)).toBe(lastFmNote);
    expect(scrobbleFooter(service({ target: 'lastfm' }), false)).toContain('aren’t sent to Last.fm');
  });

  it('asks for a token until ListenBrainz is connected and accepted', () => {
    const paste = 'Paste the user token from your ListenBrainz settings page.';
    expect(scrobbleFooter(service({ connected: false, enabled: false }), false)).toBe(paste);
    expect(scrobbleFooter(service({ needsAttention: true }), false)).toBe(paste);
  });
});

describe('disconnectConfirmation', () => {
  it('names the service and says unsent plays are dropped', () => {
    expect(disconnectConfirmation('lastfm')).toEqual({
      title: 'Disconnect Last.fm?',
      message: 'Songs you play from now on aren’t sent. Plays still waiting to be sent are dropped.',
    });
  });
});

describe('lastFmReturnFailure', () => {
  it('says why an approval came back without connecting', () => {
    expect(lastFmReturnFailure('squirmy://settings?lastfm=denied')).toBe('Last.fm wasn’t connected. The connection wasn’t approved.');
    expect(lastFmReturnFailure('squirmy-dev://settings?lastfm=invalid_state')).toBe('That Last.fm link expired. Connect again.');
    expect(lastFmReturnFailure('squirmy://settings?other=1&lastfm=error')).toBe('Last.fm didn’t answer. Try again in a moment.');
  });

  it('says nothing once connected, or for an answer it does not know', () => {
    expect(lastFmReturnFailure('squirmy://settings?lastfm=connected')).toBeNull();
    expect(lastFmReturnFailure('squirmy://settings?lastfm=surprise')).toBeNull();
    expect(lastFmReturnFailure('squirmy://settings')).toBeNull();
  });
});
