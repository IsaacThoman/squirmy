import { ApiError } from '@squirmy/client-core';
import type { User } from '@squirmy/contracts';
import { describe, expect, it } from 'vitest';
import { expiredNotice, reduceAuth, signInErrorMessage, type AuthEvent, type AuthState } from './auth';

const server = { url: 'https://music.example.com', name: 'Home', version: '1.0.0' };
const other = { url: 'http://192.168.1.20:4747', name: 'Studio', version: '1.0.0' };
const user: User = {
  id: '6f1c2e4a-1d2b-4c3d-8e9f-0a1b2c3d4e5f', username: 'ada', displayName: null, role: 'member',
  canUpload: false, canAcquire: false, createdAt: '2026-11-20T08:00:00.000Z', disabled: false,
};
const signedIn: AuthState = { status: 'signedIn', server, token: 'token-1', user };

function run(state: AuthState, ...events: AuthEvent[]) {
  return events.reduce(reduceAuth, state);
}

describe('reduceAuth', () => {
  it('restores to the first screen that applies', () => {
    const restoring: AuthState = { status: 'restoring' };
    expect(run(restoring, { type: 'restored', server: null, token: null, user: null })).toEqual({ status: 'connect', previous: null });
    expect(run(restoring, { type: 'restored', server, token: null, user: null })).toEqual({ status: 'signIn', server, notice: null });
    expect(run(restoring, { type: 'restored', server, token: null, user: null, expired: true })).toEqual({ status: 'signIn', server, notice: expiredNotice });
    expect(run(restoring, { type: 'restored', server, token: 'token-1', user })).toEqual(signedIn);
  });

  it('only restores once', () => {
    expect(run(signedIn, { type: 'restored', server: null, token: null, user: null })).toBe(signedIn);
  });

  it('connects, signs in and keeps the server when signing out', () => {
    const state = run({ status: 'connect', previous: null }, { type: 'connected', server }, { type: 'signedIn', token: 'token-1', user });
    expect(state).toEqual(signedIn);
    expect(run(state, { type: 'signedOut' })).toEqual({ status: 'signIn', server, notice: null });
  });

  it('can pick another server from sign-in', () => {
    expect(run({ status: 'signIn', server, notice: null }, { type: 'connected', server: other })).toEqual({ status: 'signIn', server: other, notice: null });
  });

  it('returns to sign-in on a 401 for the current token only', () => {
    expect(run(signedIn, { type: 'unauthorized', token: 'token-0' })).toBe(signedIn);
    expect(run(signedIn, { type: 'unauthorized', token: 'token-1' })).toEqual({ status: 'signIn', server, notice: expiredNotice });
  });

  it('switches server from sign-in or signed in, remembering the last one', () => {
    expect(run(signedIn, { type: 'switchServer' })).toEqual({ status: 'connect', previous: server });
    expect(run({ status: 'signIn', server, notice: expiredNotice }, { type: 'switchServer' })).toEqual({ status: 'connect', previous: server });
  });

  it('updates the user while signed in and ignores stray events elsewhere', () => {
    const renamed = { ...user, displayName: 'Ada' };
    expect(run(signedIn, { type: 'userLoaded', user: renamed })).toEqual({ ...signedIn, user: renamed });
    const connect: AuthState = { status: 'connect', previous: null };
    for (const event of [
      { type: 'signedIn', token: 'x', user }, { type: 'userLoaded', user }, { type: 'unauthorized', token: 'x' }, { type: 'signedOut' },
    ] satisfies AuthEvent[]) expect(run(connect, event)).toBe(connect);
    expect(run(signedIn, { type: 'connected', server: other })).toBe(signedIn);
  });
});

describe('signInErrorMessage', () => {
  it('explains each server error', () => {
    expect(signInErrorMessage(new ApiError(401, 'invalid_credentials', 'Wrong username or password'), 'Home')).toMatch(/don’t match/);
    expect(signInErrorMessage(new ApiError(403, 'account_disabled', 'This account is disabled'), 'Home')).toMatch(/disabled/);
    expect(signInErrorMessage(new ApiError(429, 'rate_limited', 'Too many attempts. Try again in 42 seconds.'), 'Home'))
      .toBe('Too many attempts. Try again in 42 seconds.');
    expect(signInErrorMessage(new ApiError(0, 'network_error', 'Network request failed'), 'Home')).toMatch(/reach Home/);
    expect(signInErrorMessage(new ApiError(400, 'invalid_invite', 'That invite code is not valid'), 'Home')).toMatch(/invite code/);
    expect(signInErrorMessage(new ApiError(409, 'username_taken', 'That username is taken'), 'Home')).toMatch(/taken/);
    expect(signInErrorMessage(new ApiError(500, 'internal_error', 'Something went wrong'), 'Home')).toMatch(/Home ran into a problem/);
  });

  it('names the field a validation error is about', () => {
    const tooShort = [{ path: ['password'], code: 'too_small' }];
    expect(signInErrorMessage(new ApiError(400, 'invalid_request', 'The request is not valid', tooShort), 'Home')).toMatch(/8 characters/);
    const username = [{ path: ['username'], code: 'invalid_format' }];
    expect(signInErrorMessage(new ApiError(400, 'invalid_request', 'The request is not valid', username), 'Home')).toMatch(/Usernames/);
  });
});
