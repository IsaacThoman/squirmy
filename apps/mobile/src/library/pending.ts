import { useMemo, useReducer } from 'react';

/**
 * Starts that wait on the server (a radio, an album's tracks), one at a time per key. A second
 * tap while the first is still waiting is ignored, so it cannot start the same thing twice.
 */
export function createStartGuard(onChange: () => void = () => undefined) {
  const running = new Set<string>();
  return {
    /** Runs `task` unless `key` is already running. Returns whether it ran. */
    run(key: string, task: () => Promise<unknown>) {
      if (running.has(key)) return false;
      running.add(key);
      onChange();
      const done = () => {
        running.delete(key);
        onChange();
      };
      task().then(done, done);
      return true;
    },
    pending: (key: string) => running.has(key),
  };
}

/** A start guard owned by a component, which re-renders it as starts begin and end. */
export function useStartGuard() {
  const [, changed] = useReducer((count: number) => count + 1, 0);
  return useMemo(() => createStartGuard(changed), []);
}
