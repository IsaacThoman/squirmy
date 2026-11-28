import { systemPath } from '../src/surfaces/links';

/** The widgets' and the Live Activity's links are followed by `SystemSurfaces`; any other link is the router's. */
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string | null {
  return systemPath(path);
}
