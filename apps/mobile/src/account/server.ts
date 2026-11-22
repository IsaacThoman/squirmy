import { ApiError, createApiClient, type FetchLike } from '@squirmy/client-core';
import type { SetupStatus } from '@squirmy/contracts';
import { displayAddress, parseServerAddress } from './address';

/**
 * `registrationRequiresInvite` is false when anyone may create an account. `wantlistEnabled`
 * is whether the server's admin turned the wantlist on; while it is off the app never shows it.
 */
export type Server = { url: string; name: string; version: string; registrationRequiresInvite: boolean; wantlistEnabled: boolean };

export type ConnectProblem = 'invalid' | 'unreachable' | 'notSquirmy' | 'serverError' | 'needsSetup' | 'cancelled';

export class ConnectError extends Error {
  override readonly name = 'ConnectError';
  /** `url` and `version` are the server that needs setup, for `needsSetup`. */
  constructor(readonly problem: ConnectProblem, message: string, readonly url?: string, readonly version?: string) {
    super(message);
  }
}

/** The server at `url` as its setup status describes it. */
export function serverFrom(url: string, status: SetupStatus): Server {
  return {
    url, name: status.serverName, version: status.version, registrationRequiresInvite: status.registrationRequiresInvite,
    // Release builds do not validate responses, and servers from before the setting leave it out.
    wantlistEnabled: status.wantlistEnabled === true,
  };
}

/** Sent as `X-Squirmy-Client` by every request from the app. */
export const clientName = 'squirmy-mobile';

/** Waits this long for a server to answer. Every address is tried at once, so this is the whole wait. */
const connectTimeoutMs = 5000;
/** Once a less preferred address (http) answers, how much longer a preferred one (https) gets. */
const preferredGraceMs = 1500;

/** `fetch` that gives up after `timeoutMs` or when the caller's signal aborts, so an unreachable address fails quickly. */
export function fetchWithTimeout(timeoutMs: number, base: typeof fetch = fetch): FetchLike {
  return async (url, init) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const outer = init.signal as AbortSignal | undefined;
    const abort = () => controller.abort();
    if (outer?.aborted) controller.abort();
    else outer?.addEventListener?.('abort', abort);
    try {
      return await base(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener?.('abort', abort);
    }
  };
}

/**
 * Runs every attempt at once and settles on the most preferred decisive result (earliest
 * index). The first attempt wins as soon as it is decisive; a later one wins when every
 * attempt before it has failed, or `graceMs` after it arrived while they still run.
 * Resolves to undefined when nothing was decisive, once everything has finished.
 */
export function preferredResult<T>(attempts: readonly Promise<T>[], decisive: (result: T) => boolean, graceMs: number): Promise<T | undefined> {
  return new Promise(resolve => {
    const results: { value: T }[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const finish = (value: T | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const settle = (graceOver: boolean) => {
      for (let index = 0; index < attempts.length; index++) {
        const result = results[index];
        if (!result) {
          if (graceOver) continue;
          if (results.some((later, at) => at > index && later && decisive(later.value))) timer ??= setTimeout(() => settle(true), graceMs);
          return;
        }
        if (decisive(result.value)) return finish(result.value);
      }
      if (attempts.every((_, index) => results[index])) finish(undefined);
    };
    attempts.forEach((attempt, index) => void attempt.then(value => {
      results[index] = { value };
      settle(false);
    }));
    if (!attempts.length) finish(undefined);
  });
}

const statusPath = /\/api\/v1\/setup\/status$/;

/**
 * The server root a probe really reached. A server that redirects (http to https, or to
 * another host) is kept at the address it redirected to, so the password is never sent to
 * the first one and every later request skips the hop.
 */
export function reachedRoot(requested: string, responseUrl: string | undefined): string {
  if (!responseUrl || !/^https?:\/\//i.test(responseUrl)) return requested;
  const path = responseUrl.replace(/[?#].*$/, '');
  return statusPath.test(path) ? path.replace(statusPath, '') : requested;
}

type Probe = { server: Server } | { error: ConnectError };

async function probe(url: string, fetchImpl: FetchLike, signal: AbortSignal): Promise<Probe> {
  let responseUrl: string | undefined;
  // The platform's response carries the address it finally came from; the client does not pass it on.
  const tracked: FetchLike = async (requestUrl, init) => {
    const response = await fetchImpl(requestUrl, { ...init, signal });
    responseUrl = (response as { url?: string }).url;
    return response;
  };
  try {
    const status = await createApiClient({ baseUrl: url, fetch: tracked, client: clientName }).auth.setupStatus();
    const root = reachedRoot(url, responseUrl);
    if (status.needsSetup) {
      return { error: new ConnectError('needsSetup', `${status.serverName} isn’t set up yet. Create the first account in a browser, then come back.`, root, status.version) };
    }
    return { server: serverFrom(root, status) };
  } catch (error) {
    return { error: describe(error, url) };
  }
}

/**
 * Finds the Squirmy server behind what the person typed by asking every candidate root
 * for `GET /setup/status` at once; https wins when both answer. Throws `ConnectError`
 * (`cancelled` once `signal` aborts); when every candidate fails, the most telling
 * failure wins (a server that answered beats one that did not).
 */
export async function findServer(input: string, fetchImpl: FetchLike = fetchWithTimeout(connectTimeoutMs), signal?: AbortSignal): Promise<Server> {
  const parsed = parseServerAddress(input);
  if (!parsed.ok) throw new ConnectError('invalid', parsed.message);

  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort);
  try {
    const attempts = parsed.candidates.map(url => probe(url, fetchImpl, controller.signal));
    // A server that answered as Squirmy, even one that needs setup, ends the search.
    const answered = (result: Probe) => 'server' in result || result.error.problem === 'needsSetup';
    const chosen = await preferredResult(attempts, answered, preferredGraceMs);
    if (signal?.aborted) throw new ConnectError('cancelled', 'Cancelled.');
    if (chosen && 'server' in chosen) return chosen.server;
    if (chosen && 'error' in chosen) throw chosen.error;
    const failures = (await Promise.all(attempts)).flatMap(result => 'error' in result ? [result.error] : []);
    throw failures.find(failure => failure.problem !== 'unreachable') ?? failures[0]!;
  } finally {
    controller.abort();
    signal?.removeEventListener('abort', abort);
  }
}

function describe(error: unknown, url: string): ConnectError {
  const address = displayAddress(url);
  if (error instanceof ApiError && error.status === 0) {
    return new ConnectError('unreachable', `Couldn’t reach ${address}. Check the address and that the server is running.`);
  }
  if (error instanceof ApiError && error.status >= 500) {
    return new ConnectError('serverError', `${address} answered with an error (${error.status}). Check that Squirmy is running.`);
  }
  // Any other answer, including one that is not the setup status, is a different server.
  return new ConnectError('notSquirmy', `${address} doesn’t look like a Squirmy server.`);
}
