import type { NormalizationMode, NormalizationTarget, ScrobbleService, StreamQuality, UpdateUserSettings, UserSettings } from '@squirmy/contracts';

/** A setting chosen from a list, opened on its own page as the system's Settings does. */
export type Choice = 'normalization' | 'target' | 'quality';

type Option<T> = { value: T; label: string };

export type ChoiceSpec = {
  title: string;
  /** Under the mark beside the list: what the choice does. */
  note: string;
  options: readonly Option<string>[];
  current: (settings: UserSettings) => string;
  change: (value: string) => UpdateUserSettings;
};

/**
 * The TV has no cellular connection, and plays at the Wi-Fi quality on Ethernet too, so it
 * shows that one setting. It is the account's, shared with the phone.
 */
export const tvQualityNote = 'Original streams the file as it is when Apple TV can play it. High is AAC at 256 kbps. Data Saver uses the least data. This is your Wi-Fi quality, so it changes on your phone too.';

/** The lists and words each choice shows, from the settings screen's own. */
export type ChoiceContent = {
  normalization: readonly Option<NormalizationMode>[];
  target: readonly Option<NormalizationTarget>[];
  quality: readonly Option<StreamQuality>[];
  normalizationNote: string;
  targetNote: string;
};

export function choiceSpec(choice: Choice, content: ChoiceContent): ChoiceSpec {
  if (choice === 'normalization') {
    return {
      title: 'Volume Normalization',
      note: content.normalizationNote,
      options: content.normalization,
      current: settings => settings.normalization,
      change: value => ({ normalization: value as NormalizationMode }),
    };
  }
  if (choice === 'target') {
    // The rows' values are strings; the setting is a number of LUFS.
    return {
      title: 'Target Loudness',
      note: content.targetNote,
      options: content.target.map(option => ({ value: String(option.value), label: option.label })),
      current: settings => String(settings.normalizationTarget ?? -18),
      change: value => ({ normalizationTarget: Number(value) as NormalizationTarget }),
    };
  }
  const quality = content.quality;
  return {
    title: 'Streaming Quality',
    note: tvQualityNote,
    options: quality,
    current: settings => settings.qualityWifi,
    change: value => ({ qualityWifi: value as StreamQuality }),
  };
}

export function isChoice(value: unknown): value is Choice {
  return value === 'normalization' || value === 'target' || value === 'quality';
}

/** A setting of this Apple TV's own, kept on it rather than in the account. */
export type DeviceChoice = 'equalizer';

export function isDeviceChoice(value: unknown): value is DeviceChoice {
  return value === 'equalizer';
}

/** The label of the chosen option, or nothing for a value this app doesn't know. */
export function optionLabel<T extends string | number>(options: readonly Option<T>[], value: T): string {
  return options.find(option => option.value === value)?.label ?? '';
}

/** A switch's value, as the system's Settings shows one. */
export function onOff(on: boolean): string {
  return on ? 'On' : 'Off';
}

/**
 * A scrobbling service's row value: its switch once connected, otherwise what it needs. The TV
 * can't open a web sign-in, so connecting happens on the phone or the web.
 */
export function scrobbleValue(service: ScrobbleService, enabled: boolean): string {
  if (!service.connected) return service.available ? 'Not Connected' : 'Not Set Up';
  if (service.needsAttention) return 'Connect Again';
  return onOff(enabled);
}

/** Whether selecting the service's row turns its scrobbling on or off. */
export function canToggleScrobbling(service: ScrobbleService): boolean {
  return service.connected && !service.needsAttention;
}

/** This app's version and build: `1.0.0 (12)`. */
export function appVersion(version: string | undefined, build: string | null | undefined): string {
  return `${version ?? ''}${build ? ` (${build})` : ''}`.trim();
}

/** The server's version as a row value. A server built from source reports `dev`. */
export function serverVersionValue(version: string): string {
  return version === 'dev' ? 'Development Build' : version;
}
