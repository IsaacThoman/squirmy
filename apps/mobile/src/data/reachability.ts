import type { FetchLike } from '@squirmy/client-core';

/** Gateway answers: a proxy in front of the server answered, the server did not. */
const unreachableStatuses = new Set([502, 503, 504]);

/** Whether an answer with this status came from a proxy in front of a server it could not reach. */
export function isGatewayStatus(status: number): boolean {
  return unreachableStatuses.has(status);
}

/**
 * What the server's HTTP answers said lately. The socket can be slow to connect (a cold
 * start, a WebSocket that falls back to polling) while requests are answered, so a request
 * the server answered also says it is there.
 */
export class HttpReach {
  /** When the server last answered a request, whatever the status. */
  answeredAt: number | undefined;
  /** When a request last could not reach the server (no answer, a timeout, a gateway error). */
  failedAt: number | undefined;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly now: () => number = Date.now) {}

  /** `fetch` that records what came of each request. A request its caller cancelled says nothing. */
  watch(fetch: FetchLike): FetchLike {
    return async (url, init) => {
      try {
        const response = await fetch(url, init);
        this.record(!isGatewayStatus(response.status));
        return response;
      } catch (error) {
        if (!init.signal?.aborted) this.record(false);
        throw error;
      }
    };
  }

  /** Calls `listener` after every recorded request. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private record(answered: boolean) {
    if (answered) this.answeredAt = this.now();
    else this.failedAt = this.now();
    for (const listener of [...this.listeners]) listener();
  }
}

export type SocketLink = {
  connected: boolean;
  /** When the socket last went down, or began its first connection. */
  downSince: number;
  /** Whether it has connected since it was opened. */
  everConnected: boolean;
};

export type OfflineTiming = {
  /** A socket that was up and has been down this long is offline; shorter drops are reconnects. */
  afterMs: number;
  /** A new socket gets this long to connect, unless a request has already failed. */
  firstConnectMs: number;
  /** A request the server answered while the socket is down keeps the app online this long. */
  answerTrustMs: number;
};

export const offlineTiming: OfflineTiming = { afterMs: 2500, firstConnectMs: 6000, answerTrustMs: 30_000 };

/**
 * When the app counts as offline if nothing else happens, or null while the socket is up.
 * Only requests made since the socket went down count: an answer from before an outage says
 * nothing about it, so a genuine outage is offline `afterMs` after the drop, as before.
 */
export function offlineAt(link: SocketLink, http: Pick<HttpReach, 'answeredAt' | 'failedAt'>, timing = offlineTiming): number | null {
  if (link.connected) return null;
  const failed = http.failedAt !== undefined && http.failedAt >= link.downSince;
  const answered = http.answeredAt !== undefined && http.answeredAt >= link.downSince
    && (!failed || http.answeredAt > http.failedAt!);
  const grace = link.everConnected || failed ? timing.afterMs : timing.firstConnectMs;
  const socketGiveUp = link.downSince + grace;
  return answered ? Math.max(socketGiveUp, http.answeredAt! + timing.answerTrustMs) : socketGiveUp;
}
