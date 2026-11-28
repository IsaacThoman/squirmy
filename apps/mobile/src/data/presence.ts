/**
 * Whether the app keeps its socket open, so that it is listed among the user's devices only
 * while it can answer (see "Presence" in the session contract).
 *
 * iOS suspends an app in the background unless it plays audio. A suspended app answers
 * nothing, yet its socket can stay open for the server's heartbeat timeout, and the server
 * would go on listing it. So the app closes its socket when it goes to the background with
 * nothing playing here, and opens it again when it returns, or when playback starts here
 * without it being opened (from the lock screen or Control Center). While this phone plays,
 * iOS keeps it running, it answers the heartbeat, and it stays listed.
 */

/** How long the app waits in the background before closing, so a command just sent (a pause from the lock screen) is answered first. */
export const PARK_DELAY_MS = 1500;

type Socket = { connect(): void; disconnect(): void };

export class BackgroundPresence {
  /** The socket was closed here, on purpose; it is not offline, and nothing else should reopen it. */
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private playing = false;
  private carPlayActive = false;
  private mediaRequest = false;

  /** `foreground`: where the app is now. An app that starts in the background with nothing playing closes too. */
  constructor(private readonly socket: Socket, private foreground: boolean, private readonly delayMs = PARK_DELAY_MS) {
    this.follow();
  }

  /** The socket is closed because the app is away and silent. Reconnect attempts wait for it to return. */
  get parked(): boolean {
    return this.closed;
  }

  /** The app came to the foreground (`active`) or went to the `background`. `inactive` is neither: Control Center over the app, a call. */
  setForeground(foreground: boolean): void {
    // Only changes count: a repeat must not put off a close already counting down.
    if (foreground === this.foreground) return;
    this.foreground = foreground;
    this.follow();
  }

  /** This phone is the one playing (its session's active device, and playing). */
  setPlaying(playing: boolean): void {
    if (playing === this.playing) return;
    this.playing = playing;
    this.follow();
  }

  /** The car's scene can be foreground while the phone is locked. */
  setCarPlayActive(active: boolean): void {
    if (active === this.carPlayActive) return;
    this.carPlayActive = active;
    this.follow();
  }

  /** Siri can wake the phone briefly to look up what the user asked to play. */
  setMediaRequest(active: boolean): void {
    if (active === this.mediaRequest) return;
    this.mediaRequest = active;
    this.follow();
  }

  dispose(): void {
    clearTimeout(this.timer);
  }

  private follow(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.foreground || this.playing || this.carPlayActive || this.mediaRequest) {
      if (!this.closed) return;
      this.closed = false;
      this.socket.connect();
      return;
    }
    if (this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.closed = true;
      this.socket.disconnect();
    }, this.delayMs);
  }
}
