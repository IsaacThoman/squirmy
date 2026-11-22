import type { FetchLike } from '@squirmy/client-core';
import { describe, expect, it } from 'vitest';
import { HttpReach, offlineAt, type SocketLink } from './reachability';

const timing = { afterMs: 2500, firstConnectMs: 6000, answerTrustMs: 30_000 };
const down = (downSince: number, everConnected = true): SocketLink => ({ connected: false, downSince, everConnected });

describe('offlineAt', () => {
  it('is never offline while the socket is up', () => {
    expect(offlineAt({ connected: true, downSince: 0, everConnected: true }, { answeredAt: undefined, failedAt: 50 }, timing)).toBeNull();
  });

  it('gives a dropped socket 2.5 seconds, whatever was answered before the drop', () => {
    expect(offlineAt(down(1000), { answeredAt: undefined, failedAt: undefined }, timing)).toBe(3500);
    expect(offlineAt(down(1000), { answeredAt: 999, failedAt: undefined }, timing)).toBe(3500);
  });

  it('gives a new socket longer, unless a request has already failed', () => {
    expect(offlineAt(down(0, false), { answeredAt: undefined, failedAt: undefined }, timing)).toBe(6000);
    expect(offlineAt(down(0, false), { answeredAt: undefined, failedAt: 400 }, timing)).toBe(2500);
  });

  it('stays online while requests are answered with the socket down', () => {
    expect(offlineAt(down(0, false), { answeredAt: 800, failedAt: undefined }, timing)).toBe(30_800);
    expect(offlineAt(down(1000), { answeredAt: 1200, failedAt: 1100 }, timing)).toBe(31_200);
  });

  it('goes offline once a request fails after the last answer', () => {
    expect(offlineAt(down(1000), { answeredAt: 1200, failedAt: 1300 }, timing)).toBe(3500);
  });
});

describe('HttpReach', () => {
  const response = (status: number) => ({ ok: status < 400, status, statusText: '', text: async () => '' });
  const init = (signal?: { aborted: boolean }) => ({ method: 'GET', headers: {}, credentials: 'omit' as const, signal });

  it('counts any answer from the server, not a gateway error or a failed request', async () => {
    let now = 0;
    const reach = new HttpReach(() => now);
    let calls = 0;
    reach.subscribe(() => { calls += 1; });
    let next: () => Promise<ReturnType<typeof response>> = async () => response(401);
    const fetch = reach.watch((async () => next()) as FetchLike);

    now = 10;
    await fetch('/me', init());
    expect(reach).toMatchObject({ answeredAt: 10, failedAt: undefined });

    now = 20;
    next = async () => response(502);
    await fetch('/me', init());
    now = 30;
    next = () => Promise.reject(new TypeError('Network request failed'));
    await expect(fetch('/me', init())).rejects.toThrow('Network request failed');
    expect(reach).toMatchObject({ answeredAt: 10, failedAt: 30 });
    expect(calls).toBe(3);
  });

  it('ignores a request its caller cancelled', async () => {
    const reach = new HttpReach(() => 5);
    const fetch = reach.watch((() => Promise.reject(new Error('Aborted'))) as FetchLike);
    await expect(fetch('/home', init({ aborted: true }))).rejects.toThrow('Aborted');
    expect(reach.failedAt).toBeUndefined();
  });
});
