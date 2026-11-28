import { beforeEach, describe, expect, it, vi } from 'vitest';

const stored = new Map<string, unknown>();
vi.mock('../../data/accountStorage', () => ({
  accountItem: (name: string) => ({
    read: () => stored.get(name) ?? null,
    write: (value: unknown) => stored.set(name, value),
    writeAsync: (value: unknown) => stored.set(name, value),
  }),
}));

describe('followOutputSettings', () => {
  beforeEach(() => {
    stored.clear();
    vi.resetModules();
  });

  it('hands the engine the stored equalizer, then each change, once', async () => {
    stored.set('equalizer', { preset: 'trebleBoost', custom: { bandsDb: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], preampDb: null } });
    const { followOutputSettings, setStoredEqualizer, storedEqualizer } = await import('./output');
    const setEqualizer = vi.fn();
    const stop = followOutputSettings({ equalizer: true, setEqualizer } as never);
    expect(setEqualizer).toHaveBeenLastCalledWith({ bandsDb: [0, 0, 0, 0, 0, 0.5, 1.5, 3, 4.5, 6], preampDb: -6 });
    setStoredEqualizer({ ...storedEqualizer(), preset: 'off' });
    expect(setEqualizer).toHaveBeenLastCalledWith(null);
    expect(stored.get('equalizer')).toMatchObject({ preset: 'off' });
    // The custom curve changed while it is not the one playing: nothing to tell the engine.
    setStoredEqualizer({ ...storedEqualizer(), custom: { bandsDb: [3, 0, 0, 0, 0, 0, 0, 0, 0, 0], preampDb: null } });
    expect(setEqualizer).toHaveBeenCalledTimes(2);
    stop();
    setStoredEqualizer({ ...storedEqualizer(), preset: 'custom' });
    expect(setEqualizer).toHaveBeenCalledTimes(2);
  });

  it('hands the engine the crossfade, and each change, once', async () => {
    stored.set('crossfade', 6);
    const { followOutputSettings, setStoredCrossfade } = await import('./output');
    const setCrossfade = vi.fn();
    const setEqualizer = vi.fn();
    const stop = followOutputSettings({ equalizer: true, setEqualizer, crossfade: true, setCrossfade } as never);
    expect(setCrossfade).toHaveBeenCalledWith(6);
    setStoredCrossfade(0);
    expect(setCrossfade).toHaveBeenLastCalledWith(0);
    expect(stored.get('crossfade')).toBe(0);
    // Only what changed goes to the engine.
    expect(setEqualizer).toHaveBeenCalledTimes(1);
    stop();
  });

  it('leaves an engine without an equalizer alone', async () => {
    const { followOutputSettings } = await import('./output');
    const setEqualizer = vi.fn();
    followOutputSettings({ equalizer: false, setEqualizer } as never)();
    expect(setEqualizer).not.toHaveBeenCalled();
  });
});
