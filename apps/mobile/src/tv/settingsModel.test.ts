import type { ScrobbleService, UserSettings } from '@squirmy/contracts';
import { describe, expect, it } from 'vitest';
import {
  appVersion, canToggleScrobbling, choiceSpec, isChoice, isDeviceChoice, onOff, optionLabel, scrobbleValue, serverVersionValue,
} from './settingsModel';

const normalization = [{ value: 'auto', label: 'Automatic' }, { value: 'off', label: 'Off' }] as const;
const quality = [{ value: 'original', label: 'Original' }, { value: 'high', label: 'High' }] as const;
const target = [{ value: -14, label: 'Loud' }, { value: -18, label: 'Standard' }] as const;
const content = { normalization, target, quality, normalizationNote: 'note', targetNote: 'how loud' };

const service = (patch: Partial<ScrobbleService> = {}): ScrobbleService => ({
  target: 'listenbrainz', available: true, connected: true, needsAttention: false, enabled: true,
  account: 'squirm', pending: 0, failed: 0, lastError: null, ...patch,
} as ScrobbleService);

describe('choiceSpec', () => {
  const settings = { normalization: 'off', qualityWifi: 'high', qualityCellular: 'original' } as UserSettings;

  it('reads and changes normalization', () => {
    const spec = choiceSpec('normalization', content);
    expect(spec.title).toBe('Volume Normalization');
    expect(spec.note).toBe('note');
    expect(spec.current(settings)).toBe('off');
    expect(spec.change('auto')).toEqual({ normalization: 'auto' });
  });

  it('reads and changes the target as the strings its rows use', () => {
    const spec = choiceSpec('target', content);
    expect(spec.title).toBe('Target Loudness');
    expect(spec.note).toBe('how loud');
    expect(spec.options).toEqual([{ value: '-14', label: 'Loud' }, { value: '-18', label: 'Standard' }]);
    expect(spec.current({ ...settings, normalizationTarget: -14 })).toBe('-14');
    // Settings kept from before there was a target.
    expect(spec.current(settings)).toBe('-18');
    expect(spec.change('-14')).toEqual({ normalizationTarget: -14 });
  });

  it('uses the Wi-Fi quality, which the TV plays at on Ethernet too', () => {
    const spec = choiceSpec('quality', content);
    expect(spec.current(settings)).toBe('high');
    expect(spec.change('original')).toEqual({ qualityWifi: 'original' });
  });
});

describe('isChoice', () => {
  it('knows only the settings it can open', () => {
    expect(isChoice('quality')).toBe(true);
    expect(isChoice('normalization')).toBe(true);
    expect(isChoice('target')).toBe(true);
    expect(isChoice('volume')).toBe(false);
    expect(isChoice(undefined)).toBe(false);
    // The device's own are not the account's.
    expect(isChoice('equalizer')).toBe(false);
  });

  it('knows the settings that belong to the device', () => {
    expect(isDeviceChoice('equalizer')).toBe(true);
    expect(isDeviceChoice('quality')).toBe(false);
  });
});

describe('row values', () => {
  it('labels the chosen option', () => {
    expect(optionLabel(quality, 'high')).toBe('High');
    expect(optionLabel(quality, 'lossless')).toBe('');
    expect(optionLabel(target, -14)).toBe('Loud');
  });

  it('shows switches as On and Off', () => {
    expect(onOff(true)).toBe('On');
    expect(onOff(false)).toBe('Off');
  });

  it('shows a service’s switch once connected, or what it needs', () => {
    expect(scrobbleValue(service(), true)).toBe('On');
    expect(scrobbleValue(service(), false)).toBe('Off');
    expect(scrobbleValue(service({ needsAttention: true }), true)).toBe('Connect Again');
    expect(scrobbleValue(service({ connected: false }), true)).toBe('Not Connected');
    expect(scrobbleValue(service({ connected: false, available: false }), true)).toBe('Not Set Up');
  });

  it('toggles only a working connection', () => {
    expect(canToggleScrobbling(service())).toBe(true);
    expect(canToggleScrobbling(service({ needsAttention: true }))).toBe(false);
    expect(canToggleScrobbling(service({ connected: false }))).toBe(false);
  });

  it('says the app and server versions', () => {
    expect(appVersion('1.2.0', '34')).toBe('1.2.0 (34)');
    expect(appVersion('1.2.0', null)).toBe('1.2.0');
    expect(appVersion(undefined, undefined)).toBe('');
    expect(serverVersionValue('1.4.0')).toBe('1.4.0');
    expect(serverVersionValue('dev')).toBe('Development Build');
  });
});
