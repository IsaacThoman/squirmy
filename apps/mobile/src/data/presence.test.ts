import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BackgroundPresence, PARK_DELAY_MS } from './presence';

function setup(foreground = true) {
  const socket = { connected: true, connect: vi.fn(() => { socket.connected = true; }), disconnect: vi.fn(() => { socket.connected = false; }) };
  return { socket, presence: new BackgroundPresence(socket, foreground) };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('BackgroundPresence', () => {
  it('closes the socket shortly after the app goes to the background with nothing playing, and opens it on return', () => {
    const { socket, presence } = setup();
    presence.setForeground(false);
    vi.advanceTimersByTime(PARK_DELAY_MS - 1);
    expect(socket.disconnect).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(socket.disconnect).toHaveBeenCalledTimes(1);
    expect(presence.parked).toBe(true);

    presence.setForeground(true);
    expect(socket.connect).toHaveBeenCalledTimes(1);
    expect(presence.parked).toBe(false);
  });

  it('stays connected in the background while this phone plays', () => {
    const { socket, presence } = setup();
    presence.setPlaying(true);
    presence.setForeground(false);
    vi.advanceTimersByTime(PARK_DELAY_MS * 10);
    expect(socket.disconnect).not.toHaveBeenCalled();
  });

  it('closes once playback here stops in the background, and opens again when it starts from the lock screen', () => {
    const { socket, presence } = setup();
    presence.setPlaying(true);
    presence.setForeground(false);
    presence.setPlaying(false);
    vi.advanceTimersByTime(PARK_DELAY_MS);
    expect(socket.disconnect).toHaveBeenCalledTimes(1);

    presence.setPlaying(true);
    expect(socket.connect).toHaveBeenCalledTimes(1);
    expect(presence.parked).toBe(false);
  });

  it('does not close when the app is back before the delay, or when playback resumes in time', () => {
    const { socket, presence } = setup();
    presence.setForeground(false);
    presence.setForeground(true);
    presence.setForeground(false);
    presence.setPlaying(true);
    vi.advanceTimersByTime(PARK_DELAY_MS * 2);
    expect(socket.disconnect).not.toHaveBeenCalled();
    expect(socket.connect).not.toHaveBeenCalled();
  });

  it('is not put off by the same news over and over, as session updates repeat it', () => {
    const { socket, presence } = setup();
    presence.setForeground(false);
    for (let tick = 0; tick < 10; tick += 1) {
      vi.advanceTimersByTime(PARK_DELAY_MS / 5);
      presence.setPlaying(false);
      presence.setForeground(false);
    }
    expect(socket.disconnect).toHaveBeenCalledTimes(1);
  });

  it('reopens for a visible CarPlay scene and parks when the car leaves the app', () => {
    const { socket, presence } = setup(false);
    vi.advanceTimersByTime(PARK_DELAY_MS);
    presence.setCarPlayActive(true);
    expect(socket.connect).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(PARK_DELAY_MS);
    expect(socket.disconnect).toHaveBeenCalledTimes(1);
    presence.setCarPlayActive(false);
    vi.advanceTimersByTime(PARK_DELAY_MS);
    expect(socket.disconnect).toHaveBeenCalledTimes(2);
  });

  it('never opens a socket it did not close', () => {
    const { socket, presence } = setup();
    presence.setForeground(true);
    presence.setPlaying(true);
    presence.setPlaying(false);
    expect(socket.connect).not.toHaveBeenCalled();
  });

  it('closes a socket of an app that starts in the background with nothing to play', () => {
    const { socket, presence } = setup(false);
    vi.advanceTimersByTime(PARK_DELAY_MS);
    expect(socket.disconnect).toHaveBeenCalledTimes(1);
    presence.dispose();
  });
});
