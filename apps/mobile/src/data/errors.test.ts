import { ApiError } from '@squirmy/client-core';
import { describe, expect, it } from 'vitest';
import { loadFailure } from './errors';

describe('loadFailure', () => {
  it('blames the connection only when the server could not be reached or failed', () => {
    expect(loadFailure(new ApiError(0, 'network_error', 'offline')).connection).toBe(true);
    expect(loadFailure(new ApiError(502, 'bad_gateway', 'Bad gateway')).connection).toBe(true);
    expect(loadFailure(new Error('boom')).connection).toBe(true);
  });

  it('says a missing item is gone, with nothing to retry', () => {
    expect(loadFailure(new ApiError(404, 'not_found', 'Album not found'))).toEqual({
      connection: false, description: 'It isn’t on the server any more.', retry: false,
    });
  });

  it('passes on the server’s reason for other refusals', () => {
    expect(loadFailure(new ApiError(400, 'unsupported_sort', 'Tracks cannot be sorted by year'))).toEqual({
      connection: false, description: 'Tracks cannot be sorted by year', retry: true,
    });
  });
});
