import { describe, expect, it } from 'vitest';
import { homeEmpty } from './homeEmpty';

describe('homeEmpty', () => {
  it('sends someone the server fetches music for to Search', () => {
    const member = homeEmpty({ canFindMusic: true, isAdmin: false, scan: null });
    expect(member).toMatchObject({ title: 'Start listening', findMusic: true });
    expect(member.description).not.toContain('Admin');
  });

  it('tells an admin where music folders are added', () => {
    expect(homeEmpty({ canFindMusic: true, isAdmin: true, scan: null }).description).toContain('Admin in Squirmy on the web');
  });

  it('tells a member who may not fetch that an admin adds the music', () => {
    const member = homeEmpty({ canFindMusic: false, isAdmin: false, scan: null });
    expect(member).toMatchObject({ title: 'No music on this server yet', findMusic: false });
    expect(member.description).toContain('a server admin');
  });

  it('says how far a scan has come, with nothing to tap', () => {
    expect(homeEmpty({ canFindMusic: true, isAdmin: true, scan: { processed: 1200, total: 4500 } })).toEqual({
      icon: 'arrow.triangle.2.circlepath', title: 'Scanning music', findMusic: false,
      description: '1,200 of 4,500 files read. Albums appear as they’re scanned.',
    });
  });
});
