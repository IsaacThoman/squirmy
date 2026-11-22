import { Activity, Headphones, KeyRound, Monitor, UserRound } from 'lucide-react'
import { useRef } from 'react'
import { useLocation, useNavigate } from 'react-router'

export const settingsSections = [
  { id: 'account', label: 'Account', icon: UserRound },
  { id: 'playback', label: 'Playback', icon: Headphones },
  { id: 'device', label: 'This browser', icon: Monitor },
  { id: 'scrobbling', label: 'Scrobbling', icon: Activity },
  { id: 'app-passwords', label: 'App passwords', icon: KeyRound },
] as const

export type SettingsSectionId = typeof settingsSections[number]['id']

/** A settings query opens the dialog over the current page; /settings also serves old links and Last.fm. */
export function useSettingsNavigation() {
  const location = useLocation()
  const navigate = useNavigate()
  const params = new URLSearchParams(location.search)
  const fullPath = { pathname: location.pathname, hash: location.hash }
  const requested = settingsSections.find(item => item.id === params.get('settings'))?.id
  const returnFocus = useRef<HTMLButtonElement | null>(null)
  const callback = params.has('lastfm') && location.pathname === '/settings'
  const previous = location.state?.settingsFromMenu === true
  const section = requested ?? (callback ? 'scrobbling' : 'account')

  return {
    open: location.pathname === '/settings' || requested !== undefined,
    section,
    show: (trigger: HTMLButtonElement | null) => {
      returnFocus.current = trigger
      params.set('settings', 'account')
      void navigate({ ...fullPath, search: params.toString() }, { state: { ...location.state, settingsFromMenu: true } })
    },
    select: (id: SettingsSectionId) => {
      params.set('settings', id)
      void navigate({ ...fullPath, search: params.toString() }, { replace: true, state: location.state })
    },
    restoreFocus: (event: Event) => {
      event.preventDefault()
      returnFocus.current?.focus()
      returnFocus.current = null
    },
    close: () => {
      if (previous) {
        void navigate(-1)
        return
      }
      params.delete('settings')
      params.delete('lastfm')
      void navigate({ ...fullPath, pathname: location.pathname === '/settings' ? '/' : location.pathname, search: params.toString() }, { replace: true })
    },
  }
}
