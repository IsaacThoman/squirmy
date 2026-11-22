import { requireNativeView, requireOptionalNativeModule, type EventSubscription } from 'expo';
import type { ComponentType } from 'react';
import type { ViewProps } from 'react-native';

export type RemoteCommand =
  | { command: 'play' | 'pause' | 'togglePlayPause' | 'next' | 'previous' }
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

/** `oldDeviceUnavailable`: the output went away, such as headphones unplugged. */
export type AudioRouteChange = { reason: 'oldDeviceUnavailable' | 'other' };

type NowPlayingModule = {
  setItem(item: NowPlayingItem): Promise<void>;
  setPlayback(playing: boolean, positionMs: number): Promise<void>;
  clear(): Promise<void>;
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
