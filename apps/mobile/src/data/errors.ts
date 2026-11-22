import { ApiError } from '@squirmy/client-core';

/**
 * What a screen says when its data failed to load. Only a failure to reach the server is the
 * connection's fault; a 404 means the thing is gone, and other refusals carry the server's
 * own message, which says more than "check your connection".
 */
export function loadFailure(error: unknown): { connection: boolean; description: string; retry: boolean } {
  if (error instanceof ApiError && error.status === 404) {
    return { connection: false, description: 'It isn’t on the server any more.', retry: false };
  }
  if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429) {
    return { connection: false, description: error.message, retry: true };
  }
  return { connection: true, description: 'Check your connection to the server.', retry: true };
}
