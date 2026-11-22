import type { FetchLike } from '@squirmy/client-core';
import type { SetupStatus } from '@squirmy/contracts';
import { describe, expect, it } from 'vitest';
import { ConnectError, findServer, serverFrom } from './server';

type Answer = { status: number; body: unknown } | 'unreachable';

/** Answers `GET <root>/api/v1/setup/status` per root and records which roots were asked. */
function serve(answers: Record<string, Answer>) {
  const asked: string[] = [];
  const fetch: FetchLike = async url => {
    const root = url.replace(/\/api\/v1\/setup\/status$/, '');
    asked.push(root);
    const answer = answers[root] ?? 'unreachable';
    if (answer === 'unreachable') throw new TypeError('Network request failed');
    return {
      ok: answer.status < 400,
      status: answer.status,
      statusText: '',
      text: async () => typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body),
    };
  };
  return { asked, fetch };
}

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
    expect(asked).toEqual(['https://music.example.com']);
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
    expect(asked).toEqual(['https://music.example.com']);
  });

  it('rejects an invalid address without a request', async () => {
    const { asked, fetch } = serve({});
    expect(await failure(findServer('not an address', fetch))).toMatchObject({ problem: 'invalid' });
    expect(asked).toEqual([]);
  });
});
