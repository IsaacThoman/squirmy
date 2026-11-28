import { requireOptionalNativeModule, type EventSubscription } from 'expo';
import { useSyncExternalStore } from 'react';
import type { CarPlayLimits, CarPlayList } from './templates';

export type CarPlayState = CarPlayLimits & { connected: boolean; active: boolean; generation: number };
export type CarPlaySelection = { templateId: string; itemId: string; requestId: string; generation: number };
export type MediaIntent = { id: string; expiresAt: number; query?: string; mediaType?: string; shuffle?: boolean; resume?: boolean };

type CarPlayModule = {
  getState(): Promise<CarPlayState>;
  setRoot(tabs: CarPlayList[], reset?: boolean): Promise<boolean>;
  push(list: CarPlayList): Promise<boolean>;
  update(list: CarPlayList): Promise<void>;
  showNowPlaying(): Promise<boolean>;
  finishSelection(requestId: string): Promise<void>;
  setNowPlaying(state: {
    shuffle: boolean; repeat: 'off' | 'all' | 'one'; liked: boolean;
    hasTrack: boolean; upNext: boolean; album: boolean;
  }): Promise<void>;
  showAlert(title: string, detail?: string): Promise<boolean>;
  pop(): Promise<boolean>;
  popToRoot(): Promise<boolean>;
  takeMediaIntents(): Promise<MediaIntent[]>;
  completeMediaIntent(id: string, success: boolean): Promise<void>;
  addListener(event: 'onStateChange', listener: (state: CarPlayState) => void): EventSubscription;
  addListener(event: 'onSelect', listener: (selection: CarPlaySelection) => void): EventSubscription;
  addListener(event: 'onTemplateAppear', listener: (event: { templateId: string; stack: string[]; generation: number }) => void): EventSubscription;
  addListener(event: 'onMediaIntent', listener: (intent: MediaIntent) => void): EventSubscription;
};

export const CarPlay = requireOptionalNativeModule<CarPlayModule>('SquirmyCarPlay');

let state: CarPlayState = {
  connected: false, active: false, generation: 0,
  maximumItems: 100, maximumSections: 10, maximumTabCount: 4, maximumImageRowItems: 4,
};
const listeners = new Set<() => void>();
let subscription: EventSubscription | undefined;

function receive(next: CarPlayState) {
  state = next;
  for (const listener of listeners) listener();
}

export function getCarPlayState(): CarPlayState {
  return state;
}

export function subscribeCarPlay(listener: () => void) {
  if (!CarPlay) return () => undefined;
  listeners.add(listener);
  if (!subscription) {
    let receivedEvent = false;
    const initial = CarPlay.addListener('onStateChange', next => {
      receivedEvent = true;
      receive(next);
    });
    subscription = initial;
    void CarPlay.getState().then(next => {
      if (subscription === initial && !receivedEvent) receive(next);
    }).catch(() => undefined);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size) return;
    subscription?.remove();
    subscription = undefined;
  };
}

export function useCarPlayState(): CarPlayState {
  return useSyncExternalStore(subscribeCarPlay, getCarPlayState);
}
