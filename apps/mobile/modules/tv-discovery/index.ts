import { NativeModule, requireOptionalNativeModule } from 'expo';

export type DiscoveredServer = { name: string; url: string };

declare class TVDiscovery extends NativeModule<{
  serversChanged: (event: { servers: DiscoveredServer[] }) => void;
}> {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function tvDiscovery() {
  return requireOptionalNativeModule<TVDiscovery>('SquirmyTVDiscovery');
}
