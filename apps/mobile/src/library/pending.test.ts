import { describe, expect, it, vi } from 'vitest';
import { createStartGuard } from './pending';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe('createStartGuard', () => {
  it('ignores a second start of the same key while the first waits', async () => {
    const guard = createStartGuard();
    const first = deferred();
    const task = vi.fn(() => first.promise);

    expect(guard.run('radio', task)).toBe(true);
    expect(guard.run('radio', task)).toBe(false);
    expect(task).toHaveBeenCalledTimes(1);
    expect(guard.pending('radio')).toBe(true);

    first.resolve();
    await first.promise;
    await Promise.resolve();
    expect(guard.pending('radio')).toBe(false);
    expect(guard.run('radio', task)).toBe(true);
  });

  it('lets different keys start at the same time', () => {
    const guard = createStartGuard();
    expect(guard.run('album:a', () => new Promise(() => undefined))).toBe(true);
    expect(guard.run('album:b', () => new Promise(() => undefined))).toBe(true);
  });

  it('frees the key when the start fails, and reports each change', async () => {
    const onChange = vi.fn();
    const guard = createStartGuard(onChange);
    const start = deferred();
    guard.run('radio', () => start.promise);
    expect(onChange).toHaveBeenCalledTimes(1);

    start.reject(new Error('offline'));
    await start.promise.catch(() => undefined);
    await Promise.resolve();
    expect(guard.pending('radio')).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});
