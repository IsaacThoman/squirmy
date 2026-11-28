import { ApiError } from '@squirmy/client-core'
import type { ScrobbleService, ScrobblingStatus } from '@squirmy/contracts'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { appPasswords, currentUser, userSettings, users } from '@/fixtures/server'
import { APPEARANCE_STORAGE_KEY, setAppearanceMode, setColorTheme } from '@/lib/appearance'
import { colorThemeStylesheet, findColorTheme } from '@/lib/color-themes'
import { modKey } from '@/lib/platform'
import { renderWithApp } from '@/test/render'
import { SettingsDialog, type SettingsDialogProps } from './SettingsDialog'

const listenBrainz: ScrobbleService = {
  target: 'listenbrainz', available: true, connected: true, account: 'alex', enabled: true, needsAttention: false, lastError: null,
  connectedAt: '2026-11-02T09:12:00.000Z', pending: 2, failed: 0,
}
const lastFm: ScrobbleService = {
  target: 'lastfm', available: false, connected: false, account: null, enabled: false, needsAttention: false, lastError: null, connectedAt: null, pending: 0, failed: 0,
}
const scrobbling = (...services: ScrobbleService[]): ScrobblingStatus => ({ services })

function props() {
  return {
    open: true,
    onOpenChange: vi.fn<SettingsDialogProps['onOpenChange']>(),
    section: 'playback',
    onSectionChange: vi.fn<SettingsDialogProps['onSectionChange']>(),
    user: currentUser,
    serverName: 'Basement',
    version: '1.4.2',
    settings: userSettings,
    onSettingsChange: vi.fn<SettingsDialogProps['onSettingsChange']>(),
    deviceName: 'Firefox on macOS',
    defaultDeviceName: 'Firefox on macOS',
    onDeviceNameChange: vi.fn<SettingsDialogProps['onDeviceNameChange']>(),
    scrobbling: scrobbling(listenBrainz, lastFm),
    onConnectListenBrainz: vi.fn<SettingsDialogProps['onConnectListenBrainz']>(async () => {}),
    onConnectLastFm: vi.fn<SettingsDialogProps['onConnectLastFm']>(),
    onDisconnect: vi.fn<SettingsDialogProps['onDisconnect']>(async () => {}),
    appPasswords,
    onCreateAppPassword: vi.fn<SettingsDialogProps['onCreateAppPassword']>(async request => ({ ...appPasswords[0], name: request.name, secret: 'sq-secret' })),
    onRevokeAppPassword: vi.fn<SettingsDialogProps['onRevokeAppPassword']>(async () => {}),
    onChangePassword: vi.fn<SettingsDialogProps['onChangePassword']>(async () => {}),
    onLogout: vi.fn<SettingsDialogProps['onLogout']>(),
  } satisfies SettingsDialogProps
}

/** Holds the open section, as the shell does. */
function Harness({ section: initial, onSectionChange, ...rest }: SettingsDialogProps) {
  const [section, setSection] = useState(initial)
  return (
    <SettingsDialog
      {...rest}
      section={section}
      onSectionChange={next => {
        onSectionChange(next)
        setSection(next)
      }}
    />
  )
}

function renderSettings(overrides: Partial<SettingsDialogProps> = {}) {
  const given = props()
  renderWithApp(<Harness {...given} {...overrides} />)
  return given
}

const settings = () => screen.getByRole('dialog', { name: 'Settings' })
const sections = () => within(within(settings()).getByRole('navigation', { name: 'Settings sections' }))
/** The open section's title; the dialog's own title is a heading of the same level. */
const panelTitles = () => within(settings()).getAllByRole('heading', { level: 2 }).map(heading => heading.textContent)

afterEach(() => {
  setAppearanceMode('system')
  setColorTheme('squirmy')
  localStorage.clear()
})

describe('SettingsDialog', () => {
  it('lists its sections and opens on the one it is given', () => {
    renderSettings()
    expect(sections().getAllByRole('button').map(button => button.textContent)).toEqual(['Playback', 'Library', 'Appearance', 'Account', 'Scrobbling', 'App passwords', 'About'])
    expect(sections().getByRole('button', { name: 'Playback' })).toHaveAttribute('aria-current', 'page')
    expect(panelTitles()).toEqual(['Settings', 'Playback'])
  })

  it.each([
    ['Library', 'library'],
    ['Appearance', 'appearance'],
    ['Account', 'account'],
    ['Scrobbling', 'scrobbling'],
    ['App passwords', 'app-passwords'],
    ['About', 'about'],
    ['Playback', 'playback'],
  ] as const)('switches to %s', async (name, id) => {
    const { onSectionChange } = renderSettings({ section: id === 'playback' ? 'about' : 'playback' })
    await userEvent.click(sections().getByRole('button', { name }))
    expect(onSectionChange).toHaveBeenCalledWith(id)
    expect(panelTitles()).toEqual(['Settings', name])
    expect(sections().getByRole('button', { name })).toHaveAttribute('aria-current', 'page')
    expect(sections().getAllByRole('button').filter(button => button.hasAttribute('aria-current'))).toHaveLength(1)
  })

  it('asks to close from its Close button', async () => {
    const { onOpenChange } = renderSettings()
    await userEvent.click(within(settings()).getByRole('button', { name: 'Close' }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('shows nothing while closed', () => {
    renderSettings({ open: false })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  describe('Library', () => {
    it('switches all of the server’s music into the library, and links to Your uploads', async () => {
      const onOpenUploads = vi.fn()
      const { onSettingsChange } = renderSettings({ section: 'library', onOpenUploads })
      const toggle = within(settings()).getByRole('switch', { name: 'Show all of this server’s music in your library' })
      expect(toggle).not.toBeChecked()
      await userEvent.click(toggle)
      expect(onSettingsChange).toHaveBeenCalledWith({ libraryIncludesServerMusic: true })
      await userEvent.click(within(settings()).getByRole('button', { name: 'Manage' }))
      expect(onOpenUploads).toHaveBeenCalled()
    })

    it('leaves out Your uploads for someone who may not upload', () => {
      renderSettings({ section: 'library' })
      expect(within(settings()).queryByRole('button', { name: 'Manage' })).toBeNull()
    })
  })

  describe('Admin panel', () => {
    it('is offered to admins and takes them there', async () => {
      const onOpenAdmin = vi.fn()
      renderSettings({ onOpenAdmin })
      await userEvent.click(within(settings()).getByRole('button', { name: 'Admin panel' }))
      expect(onOpenAdmin).toHaveBeenCalledTimes(1)
    })

    it('is not offered to anyone else', () => {
      renderSettings({ user: users[1] })
      expect(within(settings()).queryByRole('button', { name: 'Admin panel' })).not.toBeInTheDocument()
    })
  })

  describe('Playback', () => {
    it('shows the user’s settings', () => {
      renderSettings()
      expect(screen.getByRole('combobox', { name: 'Volume normalization' })).toHaveTextContent('Automatic')
      expect(screen.getByRole('combobox', { name: 'Streaming quality' })).toHaveTextContent('Original')
      expect(screen.getByRole('combobox', { name: 'Cellular quality' })).toHaveTextContent('High (AAC 256)')
    })

    it.each([
      ['Volume normalization', ['Automatic', 'Per song', 'Per album', 'Off'], 'Per album', { normalization: 'album' }],
      ['Streaming quality', ['Original', 'High (AAC 256)', 'Data saver'], 'Data saver', { qualityWifi: 'data_saver' }],
      ['Cellular quality', ['Original', 'High (AAC 256)', 'Data saver'], 'Original', { qualityCellular: 'original' }],
    ] as const)('sends a new choice of %s', async (name, choices, choice, patch) => {
      const { onSettingsChange } = renderSettings()
      await userEvent.click(screen.getByRole('combobox', { name }))
      expect((await screen.findAllByRole('option')).map(option => option.textContent)).toEqual(choices)
      await userEvent.click(screen.getByRole('option', { name: choice }))
      expect(onSettingsChange).toHaveBeenCalledTimes(1)
      expect(onSettingsChange).toHaveBeenCalledWith(patch)
    })

    it('shows the settings as they are saved', () => {
      renderSettings({ settings: { ...userSettings, normalization: 'off', qualityWifi: 'high', qualityCellular: 'data_saver' } })
      expect(screen.getByRole('combobox', { name: 'Volume normalization' })).toHaveTextContent('Off')
      expect(screen.getByRole('combobox', { name: 'Streaming quality' })).toHaveTextContent('High (AAC 256)')
      expect(screen.getByRole('combobox', { name: 'Cellular quality' })).toHaveTextContent('Data saver')
    })

    it('holds the choices back until the settings have loaded', () => {
      renderSettings({ settings: undefined })
      expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
      expect(screen.getByRole('textbox', { name: 'This browser’s name' })).toBeInTheDocument()
    })

    it('names this browser on Enter', async () => {
      const { onDeviceNameChange } = renderSettings()
      const field = screen.getByRole('textbox', { name: 'This browser’s name' })
      expect(field).toHaveValue('')
      expect(field).toHaveAttribute('placeholder', 'Firefox on macOS')
      await userEvent.type(field, '  Kitchen laptop {Enter}')
      expect(onDeviceNameChange).toHaveBeenCalledTimes(1)
      expect(onDeviceNameChange).toHaveBeenCalledWith('Kitchen laptop')
      // The field shows the name; "Saved" beside it says it reached the device lists.
      expect(screen.getByText('Saved').closest('[role="status"]')).not.toBeNull()
    })

    it('says under the playback settings when the server refused a change', () => {
      renderSettings({ errors: { playback: 'Couldn’t save that change. The server is busy.' } })
      expect(screen.getByRole('alert')).toHaveTextContent('Couldn’t save that change. The server is busy.')
    })

    it('goes back to the browser’s own name when the field is emptied and left', async () => {
      const { onDeviceNameChange } = renderSettings({ deviceName: 'Kitchen laptop' })
      const field = screen.getByRole('textbox', { name: 'This browser’s name' })
      expect(field).toHaveValue('Kitchen laptop')
      await userEvent.clear(field)
      await userEvent.tab()
      expect(onDeviceNameChange).toHaveBeenCalledWith(null)
    })

    it('does not rename the browser when the name is left as it was', async () => {
      const { onDeviceNameChange } = renderSettings({ deviceName: 'Kitchen laptop' })
      await userEvent.click(screen.getByRole('textbox', { name: 'This browser’s name' }))
      await userEvent.tab()
      expect(onDeviceNameChange).not.toHaveBeenCalled()
    })
  })

  describe('Appearance', () => {
    const root = document.documentElement
    const themeStyle = () => document.getElementById('squirmy-color-theme')
    const saved = () => JSON.parse(localStorage.getItem(APPEARANCE_STORAGE_KEY) ?? '{}') as unknown
    const mode = (name: string) => within(screen.getByRole('group', { name: 'Theme' })).getByRole('button', { name })
    const theme = (name: string) => within(screen.getByRole('group', { name: 'Color theme' })).getByRole('button', { name })

    it('starts on System and the Squirmy theme', () => {
      renderSettings({ section: 'appearance' })
      expect(within(screen.getByRole('group', { name: 'Theme' })).getAllByRole('button').map(button => button.textContent)).toEqual(['Light', 'Dark', 'System'])
      expect(mode('System')).toHaveAttribute('aria-pressed', 'true')
      expect(within(screen.getByRole('group', { name: 'Color theme' })).getAllByRole('button').map(button => button.textContent)).toEqual(['Squirmy', 'Pulpo', 'Ocean', 'Forest', 'Ember'])
      expect(theme('Squirmy')).toHaveAttribute('aria-pressed', 'true')
      expect(theme('Ocean')).toHaveAttribute('aria-pressed', 'false')
    })

    it('switches between dark and light', async () => {
      renderSettings({ section: 'appearance' })
      await userEvent.click(mode('Dark'))
      expect(root).toHaveClass('dark')
      expect(mode('Dark')).toHaveAttribute('aria-pressed', 'true')
      expect(mode('System')).toHaveAttribute('aria-pressed', 'false')
      expect(saved()).toMatchObject({ mode: 'dark', theme: 'squirmy' })

      await userEvent.click(mode('Light'))
      expect(root).not.toHaveClass('dark')
      expect(mode('Light')).toHaveAttribute('aria-pressed', 'true')
      expect(mode('Dark')).toHaveAttribute('aria-pressed', 'false')
      expect(saved()).toMatchObject({ mode: 'light', theme: 'squirmy' })
    })

    it('changes the color theme, and goes back to the default one', async () => {
      renderSettings({ section: 'appearance' })
      await userEvent.click(theme('Ocean'))
      expect(themeStyle()).toHaveTextContent(colorThemeStylesheet(findColorTheme('ocean')), { normalizeWhitespace: false })
      expect(theme('Ocean')).toHaveAttribute('aria-pressed', 'true')
      expect(theme('Squirmy')).toHaveAttribute('aria-pressed', 'false')
      expect(saved()).toMatchObject({ mode: 'system', theme: 'ocean' })

      await userEvent.click(theme('Squirmy'))
      expect(themeStyle()).not.toBeInTheDocument()
      expect(theme('Squirmy')).toHaveAttribute('aria-pressed', 'true')
    })

    it('keeps the color theme when the mode changes', async () => {
      renderSettings({ section: 'appearance' })
      await userEvent.click(theme('Ember'))
      await userEvent.click(mode('Dark'))
      expect(root).toHaveClass('dark')
      expect(theme('Ember')).toHaveAttribute('aria-pressed', 'true')
      expect(saved()).toMatchObject({ mode: 'dark', theme: 'ember' })
    })
  })

  describe('Account', () => {
    it('says the password was changed, in place of what changing it does', () => {
      renderSettings({ section: 'account', passwordChanged: true })
      expect(screen.getByText('Password changed. Your other sessions were signed out.').closest('[role="status"]')).not.toBeNull()
      expect(screen.queryByText('Changing it signs you out everywhere else.')).toBeNull()
    })

    it('shows who is signed in and logs out', async () => {
      const { onLogout } = renderSettings({ section: 'account' })
      expect(screen.getByText('Alex Rivera')).toBeInTheDocument()
      expect(screen.getByText('Admin')).toBeInTheDocument()
      expect(screen.getByText(/^@alex · joined /)).toBeInTheDocument()
      await userEvent.click(screen.getByRole('button', { name: 'Log out' }))
      expect(onLogout).toHaveBeenCalledTimes(1)
    })

    it('shows a member without a display name by their username, and offers no rename', () => {
      renderSettings({ section: 'account', user: users[2] })
      expect(screen.getByText('robin')).toBeInTheDocument()
      expect(screen.getByText('Member')).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Edit name' })).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Change password' })).toBeInTheDocument()
    })

    it('renames where the server lets the user rename themselves', async () => {
      const onRename = vi.fn(async () => {})
      renderSettings({ section: 'account', onRename })
      await userEvent.click(screen.getByRole('button', { name: 'Edit name' }))
      const dialog = within(await screen.findByRole('dialog', { name: 'Your name' }))
      expect(dialog.getByLabelText('Display name')).toHaveValue('Alex Rivera')
      await userEvent.clear(dialog.getByLabelText('Display name'))
      await userEvent.type(dialog.getByLabelText('Display name'), 'Alex R.')
      await userEvent.click(dialog.getByRole('button', { name: 'Save' }))
      expect(onRename).toHaveBeenCalledWith('Alex R.')
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Your name' })).not.toBeInTheDocument())
    })

    it('goes back to the username when the name is emptied', async () => {
      const onRename = vi.fn(async () => {})
      renderSettings({ section: 'account', onRename })
      await userEvent.click(screen.getByRole('button', { name: 'Edit name' }))
      await userEvent.clear(await screen.findByLabelText('Display name'))
      await userEvent.click(screen.getByRole('button', { name: 'Save' }))
      expect(onRename).toHaveBeenCalledWith(null)
    })
  })

  describe('Scrobbling', () => {
    it('offers opt-in sharing for now playing', async () => {
      const { onSettingsChange } = renderSettings({ section: 'scrobbling' })
      const toggle = screen.getByRole('switch', { name: 'Share what I’m listening to with other users on this server' })
      expect(toggle).not.toBeChecked()
      await userEvent.click(toggle)
      expect(onSettingsChange).toHaveBeenCalledWith({ shareNowPlaying: true })
    })

    it('shows each service’s connection and switches one off', async () => {
      const { onSettingsChange } = renderSettings({ section: 'scrobbling' })
      expect(screen.getByText('Connected as alex · 2 waiting to be sent')).toBeInTheDocument()
      expect(screen.getByText('An admin of this server has to add a Last.fm API key first.')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled()
      const toggle = screen.getByRole('switch', { name: 'Scrobble to ListenBrainz' })
      expect(toggle).toBeChecked()
      await userEvent.click(toggle)
      expect(onSettingsChange).toHaveBeenCalledWith({ scrobbleListenBrainz: false })
    })

    it('switches Last.fm on once it is connected', async () => {
      const { onSettingsChange } = renderSettings({ section: 'scrobbling', scrobbling: scrobbling({ ...lastFm, available: true, connected: true, account: 'alexr' }) })
      const toggle = screen.getByRole('switch', { name: 'Scrobble to Last.fm' })
      expect(toggle).not.toBeChecked()
      await userEvent.click(toggle)
      expect(onSettingsChange).toHaveBeenCalledWith({ scrobbleLastFm: true })
    })

    it('says at the top what Last.fm answered when it sent the browser back', () => {
      renderSettings({ section: 'scrobbling', lastFm: { message: 'That Last.fm link expired. Start connecting again.', ok: false } })
      expect(screen.getByText('That Last.fm link expired. Start connecting again.').closest('[role="status"]')).not.toBeNull()
    })

    it('says under the services when a switch was refused', () => {
      renderSettings({ section: 'scrobbling', errors: { scrobbling: 'Couldn’t save that change. The server is busy.' } })
      expect(screen.getByRole('alert')).toHaveTextContent('Couldn’t save that change. The server is busy.')
    })

    it('says in the confirmation why a disconnect was refused, and stays', async () => {
      const { onDisconnect } = renderSettings({ section: 'scrobbling' })
      onDisconnect.mockRejectedValueOnce(new ApiError(503, 'unavailable', 'The server is busy.'))
      await userEvent.click(screen.getByRole('button', { name: 'Disconnect' }))
      const confirm = within(await screen.findByRole('dialog', { name: 'Disconnect ListenBrainz?' }))
      await userEvent.click(confirm.getByRole('button', { name: 'Disconnect' }))
      expect(await confirm.findByRole('alert')).toHaveTextContent('The server is busy.')
      expect(screen.getByRole('dialog', { name: 'Disconnect ListenBrainz?' })).toBeInTheDocument()
    })

    it('disconnects a service after asking', async () => {
      const { onDisconnect } = renderSettings({ section: 'scrobbling' })
      await userEvent.click(screen.getByRole('button', { name: 'Disconnect' }))
      const confirm = within(await screen.findByRole('dialog', { name: 'Disconnect ListenBrainz?' }))
      expect(onDisconnect).not.toHaveBeenCalled()
      await userEvent.click(confirm.getByRole('button', { name: 'Disconnect' }))
      expect(onDisconnect).toHaveBeenCalledWith('listenbrainz')
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Disconnect ListenBrainz?' })).not.toBeInTheDocument())
    })

    it('connects ListenBrainz with a user token', async () => {
      const { onConnectListenBrainz } = renderSettings({ section: 'scrobbling', scrobbling: scrobbling({ ...listenBrainz, connected: false, account: null, enabled: false, pending: 0 }) })
      expect(screen.getByText('Connect with the user token from your ListenBrainz settings.')).toBeInTheDocument()
      await userEvent.click(screen.getByRole('button', { name: 'Connect' }))
      const dialog = within(await screen.findByRole('dialog', { name: 'Connect ListenBrainz' }))
      expect(dialog.getByRole('button', { name: 'Connect' })).toBeDisabled()
      await userEvent.type(dialog.getByLabelText('User token'), 'a-user-token')
      await userEvent.click(dialog.getByRole('button', { name: 'Connect' }))
      expect(onConnectListenBrainz).toHaveBeenCalledWith('a-user-token')
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Connect ListenBrainz' })).not.toBeInTheDocument())
    })

    it('sends the browser to Last.fm to connect', async () => {
      const { onConnectLastFm } = renderSettings({ section: 'scrobbling', scrobbling: scrobbling({ ...lastFm, available: true }) })
      expect(screen.getByText('Connect your Last.fm account.')).toBeInTheDocument()
      await userEvent.click(screen.getByRole('button', { name: 'Connect' }))
      expect(onConnectLastFm).toHaveBeenCalledTimes(1)
    })

    it('says when a service stopped accepting the connection and offers to reconnect', async () => {
      const { onConnectLastFm } = renderSettings({ section: 'scrobbling', scrobbling: scrobbling({ ...lastFm, available: true, connected: true, account: 'alexr', needsAttention: true, failed: 3 }) })
      expect(screen.getByText(/Connected as alexr · 3 could not be sent/)).toBeInTheDocument()
      expect(screen.getByText('Last.fm no longer accepts this connection. Connect again to keep scrobbling.')).toBeInTheDocument()
      await userEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
      expect(onConnectLastFm).toHaveBeenCalledTimes(1)
    })

    it('holds the services back until their status has loaded', () => {
      renderSettings({ section: 'scrobbling', scrobbling: undefined })
      expect(screen.queryByRole('switch', { name: /Scrobble to/ })).not.toBeInTheDocument()
      expect(screen.getByRole('switch', { name: /Share what I’m listening to/ })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Connect' })).not.toBeInTheDocument()
    })
  })

  describe('About', () => {
    it('shows the server’s name, its version and its address', () => {
      renderSettings({ section: 'about' })
      const facts = Object.fromEntries(screen.getAllByRole('term').map(term => [term.textContent, term.nextElementSibling?.textContent]))
      expect(facts).toMatchObject({ Server: 'Basement', Version: 'Squirmy 1.4.2', Address: window.location.origin })
    })

    it('lists the keyboard shortcuts', () => {
      renderSettings({ section: 'about' })
      const shortcuts = Object.fromEntries(screen.getAllByRole('term').map(term => [term.textContent, term.nextElementSibling?.textContent]))
      expect(screen.getByRole('heading', { level: 3, name: 'Keyboard shortcuts' })).toBeInTheDocument()
      expect(shortcuts).toMatchObject({ 'Search and commands': `${modKey}K`, 'All shortcuts': '?', 'Show or hide the sidebar': `${modKey}B`, Settings: `${modKey},`, 'Play or pause': 'Space' })
    })
  })
})
