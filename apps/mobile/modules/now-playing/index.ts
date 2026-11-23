import { requireNativeView, requireOptionalNativeModule, type EventSubscription } from 'expo';
import type { ComponentType } from 'react';
import type { ViewProps } from 'react-native';

export type RemoteCommand =
  /** `favorite` is the star (the like command), which stands for the heart. */
  | { command: 'play' | 'pause' | 'togglePlayPause' | 'next' | 'previous' | 'favorite' }
  | { command: 'seek'; positionMs: number };

export type NowPlayingItem = {
  title: string;
  artist?: string;
  album?: string;
  /** Loaded by the system without headers. */
  artworkUrl?: string;
  durationMs: number;
};

export type AudioInterruption = { type: 'began' } | { type: 'ended'; shouldResume: boolean };

/** An output of the audio route: `type` is the port type, such as `AirPlay`, `Speaker` or `BluetoothA2DPOutput`. */
export type AudioOutput = { type: string; name: string };

/** `oldDeviceUnavailable`: the output went away, such as headphones unplugged. */
export type AudioRouteChange = { reason: 'oldDeviceUnavailable' | 'other' };

type NowPlayingModule = {
  setItem(item: NowPlayingItem): Promise<void>;
  setPlayback(playing: boolean, positionMs: number): Promise<void>;
  /**
   * The star beside the transport controls: shown while `available`, filled while `active`.
   * `label` is what VoiceOver and the long-press menu call it. Leaves the elapsed time alone.
   */
  setFavorite(available: boolean, active: boolean, label: string): Promise<void>;
  clear(): Promise<void>;
  /** Where the sound goes now. Missing in an app built before it was added. */
  currentOutputs?: () => AudioOutput[];
  addListener(event: 'onRemoteCommand', listener: (command: RemoteCommand) => void): EventSubscription;
  addListener(event: 'onInterruption', listener: (interruption: AudioInterruption) => void): EventSubscription;
  addListener(event: 'onRouteChange', listener: (change: AudioRouteChange) => void): EventSubscription;
};

/** iOS only; `null` where there is no lock screen integration. */
export default requireOptionalNativeModule<NowPlayingModule>('SquirmyNowPlaying');

export type RoutePickerProps = ViewProps & {
  /** The AirPlay symbol's colour, and its colour while sound goes to another output. */
  tint?: string;
  activeTint?: string;
};

type ExpoGlobal = { expo?: { getViewConfig?: (moduleName: string, viewName?: string) => unknown } };

/**
 * The system AirPlay and Bluetooth picker, iOS only. `null` where the native view is missing,
 * such as Android or an app built before it was added.
 */
export const RoutePicker: ComponentType<RoutePickerProps> | null = (globalThis as ExpoGlobal).expo?.getViewConfig?.('SquirmyNowPlaying')
  ? requireNativeView<RoutePickerProps>('SquirmyNowPlaying')
  : null;

type SystemVolumeModule = {
  /** The phone's output volume, 0 to 1. */
  getVolume(): number;
  /** Moves the output volume; the system shows its volume indicator. */
  setVolume(volume: number): Promise<void>;
  addListener(event: 'onVolumeChange', listener: (change: { volume: number }) => void): EventSubscription;
};

/**
 * The phone's own output volume, which the side buttons and Control Center change. iOS only;
 * `null` elsewhere, and in an app built before it was added.
 */
export const SystemVolume = requireOptionalNativeModule<SystemVolumeModule>('SquirmySystemVolume');

export type SystemVolumeSliderProps = ViewProps & {
  /** The filled part of the track and the thumb. */
  tint?: string;
  /** The rest of the track. */
  trackTint?: string;
};

/** The system volume slider (`MPVolumeView`). It shows nothing in the iOS Simulator, which has no output volume. */
export const SystemVolumeSlider: ComponentType<SystemVolumeSliderProps> | null = SystemVolume
  && (globalThis as ExpoGlobal).expo?.getViewConfig?.('SquirmySystemVolume')
  ? requireNativeView<SystemVolumeSliderProps>('SquirmySystemVolume')
  : null;
