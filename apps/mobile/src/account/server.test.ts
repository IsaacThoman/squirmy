import type { FetchLike } from '@squirmy/client-core';
import type { SetupStatus } from '@squirmy/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectError, findServer, preferredResult, reachedRoot, serverFrom } from './server';

/** `redirectedTo` is the root the answer finally came from; `afterMs` delays it, and `hang` never answers. */
type Answer = { status: number; body: unknown; redirectedTo?: string; afterMs?: number } | 'unreachable' | 'hang';

/** Answers `GET <root>/api/v1/setup/status` per root and records which roots were asked. */
function serve(answers: Record<string, Answer>) {
  const asked: string[] = [];
  const aborted: string[] = [];
  const fetch: FetchLike = async (url, init) => {
    const root = url.replace(/\/api\/v1\/setup\/status$/, '');
    asked.push(root);
    const answer = answers[root] ?? 'unreachable';
    if (answer === 'unreachable') throw new TypeError('Network request failed');
    const signal = init.signal as AbortSignal | undefined;
    if (answer === 'hang' || answer.afterMs) {
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          aborted.push(root);
          reject(new TypeError('Aborted'));
        };
        if (signal?.aborted) return abort();
        if (answer !== 'hang') setTimeout(resolve, answer.afterMs);
        signal?.addEventListener('abort', abort);
      });
    }
    if (answer === 'hang') throw new TypeError('Aborted');
    return {
      ok: answer.status < 400,
      status: answer.status,
      statusText: '',
      url: `${answer.redirectedTo ?? root}/api/v1/setup/status`,
      text: async () => typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body),
    };
  };
  return { asked, aborted, fetch };
}

afterEach(() => {
  vi.useRealTimers();
});

const status = { needsSetup: false, version: '1.4.0', serverName: 'Home', registrationRequiresInvite: true };

async function failure(promise: Promise<unknown>): Promise<ConnectError> {
  const error = await promise.then(() => null, (reason: unknown) => reason);
  if (!(error instanceof ConnectError)) throw new Error(`Expected a ConnectError, got ${String(error)}`);
  return error;
}

describe('findServer', () => {
  it('returns the server name and version', async () => {
    const { asked, fetch } = serve({ 'https://music.example.com': { status: 200, body: status } });
    await expect(findServer('music.example.com/', fetch)).resolves.toEqual({
      url: 'https://music.example.com', name: 'Home', version: '1.4.0', registrationRequiresInvite: true, wantlistEnabled: false,
    });
    expect(asked).toEqual(['https://music.example.com', 'http://music.example.com']);
  });

  it('shows the wantlist only when the server says it is on', async () => {
    const { fetch } = serve({ 'https://music.example.com': { status: 200, body: { ...status, wantlistEnabled: true } } });
    await expect(findServer('music.example.com', fetch)).resolves.toMatchObject({ wantlistEnabled: true });
    // Servers from before the setting leave it out.
    expect(serverFrom('https://old.example.com', status as SetupStatus).wantlistEnabled).toBe(false);
  });

  it('falls back to http when https is unreachable', async () => {
    const { asked, fetch } = serve({ 'http://192.168.1.20:4747': { status: 200, body: status } });
    await expect(findServer('192.168.1.20:4747', fetch)).resolves.toMatchObject({ url: 'http://192.168.1.20:4747' });
    expect(asked).toEqual(['https://192.168.1.20:4747', 'http://192.168.1.20:4747']);
  });

  it('keeps the https address an http address redirects to', async () => {
    const { fetch } = serve({ 'http://music.example.com': { status: 200, body: status, redirectedTo: 'https://music.example.com' } });
    await expect(findServer('http://music.example.com', fetch)).resolves.toMatchObject({ url: 'https://music.example.com' });
  });

  it('prefers https when both answer, even when http answers first', async () => {
    const { fetch } = serve({
      'https://192.168.1.20:4747': { status: 200, body: status, afterMs: 30 },
      'http://192.168.1.20:4747': { status: 200, body: status },
    });
    await expect(findServer('192.168.1.20:4747', fetch)).resolves.toMatchObject({ url: 'https://192.168.1.20:4747' });
  });

  it('takes http without waiting out an https address that never answers', async () => {
    vi.useFakeTimers();
    const { aborted, fetch } = serve({ 'https://192.168.1.20:4747': 'hang', 'http://192.168.1.20:4747': { status: 200, body: status } });
    const found = findServer('192.168.1.20:4747', fetch);
    await vi.advanceTimersByTimeAsync(1500);
    await expect(found).resolves.toMatchObject({ url: 'http://192.168.1.20:4747' });
    expect(aborted).toEqual(['https://192.168.1.20:4747']);
  });

  it('stops asking when cancelled', async () => {
    const { aborted, fetch } = serve({ 'https://music.example.com': 'hang', 'http://music.example.com': 'hang' });
    const controller = new AbortController();
    const found = failure(findServer('music.example.com', fetch, controller.signal));
    controller.abort();
    expect(await found).toMatchObject({ problem: 'cancelled' });
    expect(aborted.sort()).toEqual(['http://music.example.com', 'https://music.example.com']);
  });

  it('says when nothing answers', async () => {
    const { fetch } = serve({});
    expect(await failure(findServer('music.example.com', fetch))).toMatchObject({ problem: 'unreachable', message: expect.stringMatching(/Couldn’t reach music.example.com/) });
  });

  it('prefers a server that answered over one that did not', async () => {
    const { fetch } = serve({ 'https://example.com': { status: 404, body: '<html>Not found</html>' } });
    expect(await failure(findServer('example.com', fetch))).toMatchObject({ problem: 'notSquirmy' });
  });

  it('rejects answers that are not a setup status', async () => {
    const { fetch } = serve({ 'https://example.com': { status: 200, body: { hello: 'world' } } });
    expect(await failure(findServer('https://example.com', fetch))).toMatchObject({ problem: 'notSquirmy' });
  });

  it('reports server errors', async () => {
    const { fetch } = serve({ 'https://music.example.com': { status: 502, body: 'Bad gateway' } });
    expect(await failure(findServer('https://music.example.com', fetch))).toMatchObject({ problem: 'serverError' });
  });

  it('asks to finish setup in a browser, with the address', async () => {
    const { asked, fetch } = serve({ 'https://music.example.com': { status: 200, body: { ...status, needsSetup: true } } });
    expect(await failure(findServer('music.example.com', fetch))).toMatchObject({ problem: 'needsSetup', url: 'https://music.example.com', version: '1.4.0' });
    expect(asked).toContain('https://music.example.com');
  });

  it('rejects an invalid address without a request', async () => {
    const { asked, fetch } = serve({});
    expect(await failure(findServer('not an address', fetch))).toMatchObject({ problem: 'invalid' });
    expect(asked).toEqual([]);
  });
});

describe('reachedRoot', () => {
  it('uses the root a redirect ended at', () => {
    expect(reachedRoot('http://music.example.com', 'https://music.example.com/api/v1/setup/status')).toBe('https://music.example.com');
    expect(reachedRoot('http://example.com/squirmy', 'https://home.example.com/squirmy/api/v1/setup/status?x=1')).toBe('https://home.example.com/squirmy');
  });

  it('keeps the requested root when the response does not say where it came from', () => {
    expect(reachedRoot('http://music.example.com', undefined)).toBe('http://music.example.com');
    expect(reachedRoot('http://music.example.com', '')).toBe('http://music.example.com');
    expect(reachedRoot('http://music.example.com', 'https://music.example.com/login')).toBe('http://music.example.com');
  });
});

describe('preferredResult', () => {
  const later = <T,>(value: T, ms: number) => new Promise<T>(resolve => setTimeout(() => resolve(value), ms));
  const good = (value: string) => value.startsWith('ok');

  it('takes the first attempt as soon as it is good', async () => {
    vi.useFakeTimers();
    const result = preferredResult([later('ok https', 10), later('ok http', 5000)], good, 1500);
    await vi.advanceTimersByTimeAsync(10);
    await expect(result).resolves.toBe('ok https');
  });

  it('waits a little for the first attempt after a later one is good', async () => {
    vi.useFakeTimers();
    const result = preferredResult([later('ok https', 1000), later('ok http', 10)], good, 1500);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(result).resolves.toBe('ok https');
  });

  it('gives up on a slow first attempt after the grace period', async () => {
    vi.useFakeTimers();
    let settled: string | undefined;
    void preferredResult([later('ok https', 4000), later('ok http', 10)], good, 1500).then(value => { settled = value; });
    await vi.advanceTimersByTimeAsync(1000);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(510);
    expect(settled).toBe('ok http');
  });

  it('takes a later attempt at once when the first has failed', async () => {
    vi.useFakeTimers();
    const result = preferredResult([later('failed', 5), later('ok http', 10)], good, 1500);
    await vi.advanceTimersByTimeAsync(10);
    await expect(result).resolves.toBe('ok http');
  });

  it('resolves to undefined once every attempt has failed', async () => {
    await expect(preferredResult([Promise.resolve('failed'), Promise.resolve('also failed')], good, 1500)).resolves.toBeUndefined();
    await expect(preferredResult([], good, 1500)).resolves.toBeUndefined();
  });
});
