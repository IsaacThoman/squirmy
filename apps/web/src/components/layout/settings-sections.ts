import { AudioLines, Headphones, KeyRound, Palette, UserRound } from 'lucide-react'

export const settingsSections = [
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'playback', label: 'Playback', icon: Headphones },
  { id: 'scrobbling', label: 'Scrobbling', icon: AudioLines },
  { id: 'app-passwords', label: 'App passwords', icon: KeyRound },
  { id: 'account', label: 'Account', icon: UserRound },
] as const

export type SettingsSectionId = typeof settingsSections[number]['id']
export const isSettingsSection = (section: string | undefined): section is SettingsSectionId => settingsSections.some(item => item.id === section)
