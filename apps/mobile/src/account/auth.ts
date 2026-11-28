import { ApiError } from '@squirmy/client-core';
import type { User } from '@squirmy/contracts';
import type { Server } from './server';

/**
 * Where the app is in getting to the library: checking what it stored, choosing a
 * server, signing in to it, or signed in. `notice` explains why sign-in is showing again.
 */
export type AuthState =
  | { status: 'restoring' }
  | { status: 'connect'; previous: Server | null }
  | { status: 'signIn'; server: Server; notice: string | null }
  | { status: 'signedIn'; server: Server; token: string; user: User };

export type AuthEvent =
  /** The stored session was checked. `expired` when the server no longer accepts its token. */
  | { type: 'restored'; server: Server | null; token: string | null; user: User | null; expired?: boolean }
  | { type: 'connected'; server: Server }
  | { type: 'signedIn'; token: string; user: User }
  | { type: 'userLoaded'; user: User }
  /** The server answered `GET /setup/status` again: its name, version, invite rule or wantlist switch may have changed. */
  | { type: 'serverLoaded'; server: Server }
  /** A request made with `token` came back 401. */
  | { type: 'unauthorized'; token: string }
  | { type: 'signedOut' }
  | { type: 'switchServer' }
  /**
   * Another saved account is being opened. Nothing is signed in until its saved library is
   * read back, so no screen asks a server meanwhile; `restored` then opens it.
   */
  | { type: 'switching' };

export const expiredNotice = 'Your session ended. Sign in again to keep listening.';

export function reduceAuth(state: AuthState, event: AuthEvent): AuthState {
  switch (event.type) {
    case 'restored':
      if (state.status !== 'restoring') return state;
      if (!event.server) return { status: 'connect', previous: null };
      if (!event.token || !event.user) {
        return { status: 'signIn', server: event.server, notice: event.expired ? expiredNotice : null };
      }
      return { status: 'signedIn', server: event.server, token: event.token, user: event.user };
    case 'connected':
      return state.status === 'connect' || state.status === 'signIn'
        ? { status: 'signIn', server: event.server, notice: null }
        : state;
    case 'signedIn':
      return state.status === 'signIn'
        ? { status: 'signedIn', server: state.server, token: event.token, user: event.user }
        : state;
    case 'userLoaded':
      return state.status === 'signedIn' ? { ...state, user: event.user } : state;
    case 'serverLoaded':
      return (state.status === 'signIn' || state.status === 'signedIn') && state.server.url === event.server.url
        && !sameServer(state.server, event.server)
        ? { ...state, server: event.server }
        : state;
    case 'unauthorized':
      // A late 401 for a token that was already replaced says nothing about this one.
      return state.status === 'signedIn' && state.token === event.token
        ? { status: 'signIn', server: state.server, notice: expiredNotice }
        : state;
    case 'signedOut':
      return state.status === 'signedIn' ? { status: 'signIn', server: state.server, notice: null } : state;
    case 'switchServer':
      return state.status === 'signIn' || state.status === 'signedIn'
        ? { status: 'connect', previous: state.server }
        : state;
    case 'switching':
      return { status: 'restoring' };
  }
}

function sameServer(a: Server, b: Server): boolean {
  return a.name === b.name && a.version === b.version && a.registrationRequiresInvite === b.registrationRequiresInvite
    && a.wantlistEnabled === b.wantlistEnabled && a.supportsTvDevices === b.supportsTvDevices
    && (a.sharingEnabled ?? false) === (b.sharingEnabled ?? false);
}

/** What to tell the person when signing in or registering fails. */
export function signInErrorMessage(error: unknown, serverName: string): string {
  if (!(error instanceof ApiError)) return 'Something went wrong. Try again.';
  switch (error.code) {
    case 'network_error': return `Couldn’t reach ${serverName}. Check your connection and try again.`;
    case 'invalid_credentials': return 'That username and password don’t match.';
    case 'account_disabled': return 'This account is disabled. Ask the server’s admin to turn it back on.';
    case 'rate_limited': return error.message;
    case 'invalid_invite': return 'That invite code isn’t valid. It may have expired or been used.';
    case 'invite_required': return 'You need an invite code to create an account on this server.';
    case 'username_taken': return 'That username is taken. Try another one.';
    case 'invalid_request': return invalidFieldMessage(error.details);
  }
  return error.status >= 500 ? `${serverName} ran into a problem. Try again in a moment.` : error.message;
}

function invalidFieldMessage(details: unknown): string {
  const issue = Array.isArray(details) ? details[0] as { path?: unknown[]; code?: string } | undefined : undefined;
  const field = issue?.path?.[0];
  if (field === 'password' && issue?.code === 'too_small') return 'Use a password with at least 8 characters.';
  if (field === 'password') return 'That password is too long.';
  if (field === 'username') return 'Usernames are 2 to 40 letters, numbers, dots, dashes or underscores.';
  return 'Check what you entered and try again.';
}
