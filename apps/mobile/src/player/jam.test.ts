import { describe, expect, it } from 'vitest';
import { jamIdFrom } from './jam';

describe('invite links', () => {
  it('reads the jam from a pasted link or id', () => {
    expect(jamIdFrom(' https://music.example.com/jam/gb3NZJkHJKoF3tE2P61XiQ ')).toBe('gb3NZJkHJKoF3tE2P61XiQ');
    expect(jamIdFrom('https://music.example.com/jam/gb3NZJkHJKoF3tE2P61XiQ?from=chat')).toBe('gb3NZJkHJKoF3tE2P61XiQ');
    expect(jamIdFrom('gb3NZJkHJKoF3tE2P61XiQ')).toBe('gb3NZJkHJKoF3tE2P61XiQ');
  });

  it('turns down what is not one', () => {
    expect(jamIdFrom('hello')).toBeNull();
    expect(jamIdFrom('https://music.example.com/album/123')).toBeNull();
    expect(jamIdFrom('https://music.example.com/jam/%E0%A4%A')).toBeNull();
  });
});
