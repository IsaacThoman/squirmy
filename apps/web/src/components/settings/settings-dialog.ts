import { createContext, useContext } from 'react'

export const SETTINGS_SECTIONS = ['playback', 'library', 'appearance', 'account', 'security', 'app-passwords', 'share-links', 'scrobbling', 'webhooks', 'about'] as const
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]

export function isSettingsSection(value: string | null | undefined): value is SettingsSection {
  return SETTINGS_SECTIONS.includes(value as SettingsSection)
}

/**
 * `lastFm`: Last.fm sent the browser back with this answer (`?lastfm=`), said in the Scrobbling section.
 * `sso`: single sign-on sent it back from linking (`?sso=linked`, or `?sso_error=<code>`), said in Security.
 */
export type SettingsOpenOptions = { lastFm?: string; sso?: string }

type SettingsDialogController = {
  /** Opens the settings dialog, on a section when one is given. */
  openSettings: (section?: SettingsSection, options?: SettingsOpenOptions) => void
}

export const SettingsDialogContext = createContext<SettingsDialogController | null>(null)

/** Opens the settings dialog from anywhere in the signed-in app. */
export function useSettingsDialog(): SettingsDialogController {
  const controller = useContext(SettingsDialogContext)
  if (!controller) throw new Error('useSettingsDialog needs the app shell')
  return controller
}
