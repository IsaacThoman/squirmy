/// <reference types="node" />
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The app has no toasts: what happened shows where it happened (on the heart, under the
 * button, in the sheet, in the player's status line). This fails if a notice system comes
 * back, by name or by import.
 */
const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const self = fileURLToPath(import.meta.url);

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.[jt]sx?$/.test(entry.name) && path !== self ? [path] : [];
  });
}

const files = [...sources(join(root, 'src')), ...sources(join(root, 'app'))];
const bannedFile = /^(Notice|Notices|Toast|Toasts|Snackbar)(\.(ios|android))?\.[jt]sx?$/;
const bannedCode = [
  /\buseNotice\b/, /\bNoticeProvider\b/, /\buseToast\b/, /\bToastProvider\b/,
  /from\s+['"][^'"]*\/(Notice|Toast)['"]/, /require\(\s*['"][^'"]*\/(Notice|Toast)['"]\s*\)/,
  /['"](react-native-toast-message|react-native-root-toast|burnt|sonner-native)['"]/,
];

describe('no toasts', () => {
  it('reads the app’s sources', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('has no notice or toast component', () => {
    expect(files.filter(file => bannedFile.test(basename(file))).map(file => relative(root, file))).toEqual([]);
  });

  it('never uses or imports one', () => {
    const found = files.flatMap(file => {
      const text = readFileSync(file, 'utf8');
      return bannedCode.filter(pattern => pattern.test(text)).map(pattern => `${relative(root, file)}: ${pattern}`);
    });
    expect(found).toEqual([]);
  });
});
