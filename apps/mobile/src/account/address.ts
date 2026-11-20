/** The server roots to try for what the person typed, in order, or why it is not an address. */
export type ParsedAddress = { ok: true; candidates: string[] } | { ok: false; message: string };

const schemePattern = /^([a-z][a-z0-9+.-]*):\/\//i;
const hostPattern = /^(\[[0-9a-f:.]+\]|[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*)(:(\d{1,5}))?$/i;

/**
 * Turns `music.example.com`, `http://192.168.1.20:4747/` or a pasted web app link into
 * server roots without a trailing slash. Without a scheme, https is tried before http.
 * A path is kept for servers behind a reverse proxy, minus a trailing `/api/v1`.
 */
export function parseServerAddress(input: string): ParsedAddress {
  let rest = input.trim().replace(/[?#].*$/, '');
  if (!rest) return { ok: false, message: 'Enter the address of your server.' };

  let schemes = ['https', 'http'];
  const scheme = schemePattern.exec(rest);
  if (scheme) {
    const name = scheme[1].toLowerCase();
    if (name !== 'http' && name !== 'https') return { ok: false, message: 'Use an http or https address.' };
    schemes = [name];
    rest = rest.slice(scheme[0].length);
  }

  const slash = rest.indexOf('/');
  const authority = slash < 0 ? rest : rest.slice(0, slash);
  const host = hostPattern.exec(authority);
  const port = host?.[6] ? Number(host[6]) : undefined;
  if (!host || (port !== undefined && (port < 1 || port > 65535))) {
    return { ok: false, message: 'That doesn’t look like a server address. Try something like music.example.com.' };
  }
  const path = slash < 0 ? '' : rest.slice(slash).replace(/\/+$/, '').replace(/\/api\/v1$/i, '');
  const root = `${host[1].toLowerCase()}${port === undefined ? '' : `:${port}`}${path}`;
  return { ok: true, candidates: schemes.map(name => `${name}://${root}`) };
}

/** `https://music.example.com` → `music.example.com`, for display. */
export function displayAddress(url: string): string {
  return url.replace(/^https:\/\//, '');
}

/**
 * The server is reached over plain HTTP on something other than this device or a private
 * network, so passwords and tokens cross the internet unencrypted.
 */
export function isExposedHttp(url: string): boolean {
  const match = /^http:\/\/(\[[^\]]+\]|[^/:]+)/i.exec(url);
  if (!match) return false;
  const host = match[1].toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.lan') || host.endsWith('.home.arpa') || !host.includes('.') && !host.includes(':')) return false;
  if (host === '::1' || /^f[cd][0-9a-f]{2}:/.test(host) || host.startsWith('fe80:')) return false;
  const octets = host.split('.').map(Number);
  if (octets.length !== 4 || octets.some(octet => !Number.isInteger(octet))) return true;
  const [a, b] = octets;
  return !(a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)
    || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127));
}
