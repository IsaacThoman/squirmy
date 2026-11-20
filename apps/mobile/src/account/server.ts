import { ApiError, createApiClient, type FetchLike } from '@squirmy/client-core';
import type { SetupStatus } from '@squirmy/contracts';
import { displayAddress, parseServerAddress } from './address';

/** `registrationRequiresInvite` is false when anyone may create an account. */
export type Server = { url: string; name: string; version: string; registrationRequiresInvite: boolean };

export type ConnectProblem = 'invalid' | 'unreachable' | 'notSquirmy' | 'serverError' | 'needsSetup';

export class ConnectError extends Error {
  override readonly name = 'ConnectError';
  /** `url` and `version` are the server that needs setup, for `needsSetup`. */
  constructor(readonly problem: ConnectProblem, message: string, readonly url?: string, readonly version?: string) {
    super(message);
  }
}

/** The server at `url` as its setup status describes it. */
export function serverFrom(url: string, status: SetupStatus): Server {
  return { url, name: status.serverName, version: status.version, registrationRequiresInvite: status.registrationRequiresInvite };
}

/** Sent as `X-Squirmy-Client` by every request from the app. */
export const clientName = 'squirmy-mobile';

/** Waits this long for a server to answer before trying the next address. */
const connectTimeoutMs = 8000;

/** `fetch` that gives up after `timeoutMs`, so an unreachable address fails quickly. */
export function fetchWithTimeout(timeoutMs: number, base: typeof fetch = fetch): FetchLike {
  return async (url, init) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await base(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Finds the Squirmy server behind what the person typed by asking each candidate root
 * for `GET /setup/status`. Throws `ConnectError`; when every candidate fails, the most
 * telling failure wins (a server that answered beats one that did not).
 */
export async function findServer(input: string, fetchImpl: FetchLike = fetchWithTimeout(connectTimeoutMs)): Promise<Server> {
  const parsed = parseServerAddress(input);
  if (!parsed.ok) throw new ConnectError('invalid', parsed.message);

  let failure: ConnectError | undefined;
  for (const url of parsed.candidates) {
    const api = createApiClient({ baseUrl: url, fetch: fetchImpl, client: clientName });
    try {
      const status = await api.auth.setupStatus();
      if (status.needsSetup) {
        throw new ConnectError('needsSetup', `${status.serverName} isn’t set up yet. Create the first account in a browser, then come back.`, url, status.version);
      }
      return serverFrom(url, status);
    } catch (error) {
      if (error instanceof ConnectError) throw error;
      const problem = describe(error, url);
      if (!failure || (failure.problem === 'unreachable' && problem.problem !== 'unreachable')) failure = problem;
    }
  }
  throw failure!;
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
