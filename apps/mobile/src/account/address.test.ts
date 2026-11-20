import { describe, expect, it } from 'vitest';
import { displayAddress, isExposedHttp, parseServerAddress } from './address';

describe('parseServerAddress', () => {
  it('tries https before http when the scheme is missing', () => {
    expect(parseServerAddress('music.example.com')).toEqual({
      ok: true, candidates: ['https://music.example.com', 'http://music.example.com'],
    });
  });

  it('keeps an explicit scheme and port, and drops trailing slashes', () => {
    expect(parseServerAddress(' http://192.168.1.20:4747/ ')).toEqual({ ok: true, candidates: ['http://192.168.1.20:4747'] });
    expect(parseServerAddress('HTTPS://Music.Example.com///')).toEqual({ ok: true, candidates: ['https://music.example.com'] });
  });

  it('tries both schemes for a bare address with a port', () => {
    expect(parseServerAddress('nas:4747')).toEqual({ ok: true, candidates: ['https://nas:4747', 'http://nas:4747'] });
  });

  it('keeps a reverse proxy path but not the API prefix, query or fragment', () => {
    expect(parseServerAddress('https://home.example.com/squirmy/api/v1/?x=1#top')).toEqual({
      ok: true, candidates: ['https://home.example.com/squirmy'],
    });
  });

  it('accepts IPv6 literals', () => {
    expect(parseServerAddress('http://[fd00::2]:4747')).toEqual({ ok: true, candidates: ['http://[fd00::2]:4747'] });
  });

  it('rejects what is not an address', () => {
    expect(parseServerAddress('   ').ok).toBe(false);
    expect(parseServerAddress('ftp://music.example.com').ok).toBe(false);
    expect(parseServerAddress('music example').ok).toBe(false);
    expect(parseServerAddress('music.example.com:99999').ok).toBe(false);
    expect(parseServerAddress('user@music.example.com').ok).toBe(false);
    expect(parseServerAddress('-music.example.com').ok).toBe(false);
  });
});

describe('displayAddress', () => {
  it('hides https but keeps http visible', () => {
    expect(displayAddress('https://music.example.com')).toBe('music.example.com');
    expect(displayAddress('http://192.168.1.20:4747')).toBe('http://192.168.1.20:4747');
  });
});

describe('isExposedHttp', () => {
  it('ignores https and local or private hosts', () => {
    for (const url of [
      'https://music.example.com', 'http://localhost:4747', 'http://nas:4747', 'http://music.local',
      'http://192.168.1.20:4747', 'http://10.0.0.4', 'http://172.20.1.1', 'http://100.101.102.103', 'http://[fd00::2]:4747',
    ]) expect(isExposedHttp(url), url).toBe(false);
  });

  it('flags plain http to public hosts', () => {
    for (const url of ['http://music.example.com', 'http://8.8.8.8:4747', 'http://172.32.0.1']) {
      expect(isExposedHttp(url), url).toBe(true);
    }
  });
});
