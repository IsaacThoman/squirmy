import { createContext, useContext } from 'react'

export const SETTINGS_SECTIONS = ['playback', 'library', 'appearance', 'account', 'scrobbling', 'app-passwords', 'share-links', 'webhooks', 'about'] as const
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]

export function isSettingsSection(value: string | null | undefined): value is SettingsSection {
  return SETTINGS_SECTIONS.includes(value as SettingsSection)
}

/** `lastFm`: Last.fm sent the browser back with this answer (`?lastfm=`), said in the Scrobbling section. */
export type SettingsOpenOptions = { lastFm?: string }

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
