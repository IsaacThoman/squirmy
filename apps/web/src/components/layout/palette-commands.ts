import { listedDevices, sleepTimerChoices } from '@squirmy/client-core'
import {
  AudioWaveform, Disc3, Heart, Infinity as InfinityIcon, Keyboard, ListMusic, ListPlus, ListX, MessageSquareQuote, MicVocal, MonitorSpeaker, PanelLeft, Pause, PictureInPicture2, Play, Radio, Repeat,
  Moon, Repeat1, Settings, Shuffle, SkipBack, SkipForward, TimerOff, Volume2, VolumeX, Maximize2,
} from 'lucide-react'
import { useNavigate } from 'react-router'
import { isApple } from '@/lib/platform'
import { useLibrary } from '@/player/library-context'
import { labelDevice, useJamRights, usePlayer } from '@/player/player-context'
import { toggleMute } from '@/components/player/mute'
import type { SettingsSection } from '@/components/settings/settings-dialog'
import type { ShellCommands } from './AppShell'
import type { PaletteCommand } from './SearchDialog'

const mod = isApple ? '⌘' : 'Ctrl+'
const shift = isApple ? '⇧' : 'Shift+'

const settingsSections: { section: SettingsSection; label: string }[] = [
  { section: 'playback', label: 'Playback' },
  { section: 'appearance', label: 'Appearance' },
  { section: 'account', label: 'Account' },
  { section: 'scrobbling', label: 'Scrobbling' },
]

/**
 * What the command palette (⌘K) can do, worded by what each would do now ("Pause" while it
 * plays). The list is built when the dialog renders, which it does only while open.
 */
export function usePaletteCommands(shell: ShellCommands): PaletteCommand[] {
  const { state, controls } = usePlayer()
  const library = useLibrary()
  const navigate = useNavigate()
  const rights = useJamRights()
  const track = state.current?.track
  const none = !track
  const deviceId = state.activeDeviceId ?? state.thisDeviceId
  const nextRepeat = state.repeat === 'off' ? 'Repeat all' : state.repeat === 'all' ? 'Repeat one' : 'Turn off repeat'
  // Devices that playback can move to: the shared session's, other than the one playing.
  const targets = state.detached ? [] : listedDevices(state.devices, state.thisDeviceId).filter(device => !device.detached && device.id !== deviceId)

  const commands: PaletteCommand[] = [
    { id: 'play-pause', label: state.playing ? 'Pause' : 'Play', icon: state.playing ? Pause : Play, keywords: ['resume', 'stop', 'toggle playback'], shortcut: 'Space', disabled: none, run: controls.togglePlay },
    { id: 'next', label: 'Next song', icon: SkipForward, keywords: ['skip', 'forward'], shortcut: `${shift}→`, disabled: none, run: controls.next },
    { id: 'previous', label: 'Previous song', icon: SkipBack, keywords: ['back', 'restart'], shortcut: `${shift}←`, disabled: none, run: controls.previous },
    { id: 'shuffle', label: state.shuffle ? 'Turn off shuffle' : 'Turn on shuffle', icon: Shuffle, keywords: ['random'], shortcut: 'S', run: () => controls.setShuffle(!state.shuffle) },
    { id: 'repeat', label: nextRepeat, icon: state.repeat === 'all' ? Repeat1 : Repeat, keywords: ['loop', 'repeat'], shortcut: 'R', run: controls.cycleRepeat },
    { id: 'autoplay', label: state.autoplay ? 'Turn off Autoplay' : 'Turn on Autoplay', icon: InfinityIcon, keywords: ['similar', 'keep playing'], run: () => controls.setAutoplay(!state.autoplay) },
    { id: 'mute', label: state.volume === 0 ? 'Unmute' : 'Mute', icon: state.volume === 0 ? Volume2 : VolumeX, keywords: ['volume', 'sound'], shortcut: 'M', run: () => toggleMute(state.volume, deviceId, volume => controls.setVolume(volume)) },
    ...(track ? [
      {
        id: 'like',
        label: track.liked ? `Remove “${track.title}” from your library` : `Save “${track.title}” to your library`,
        icon: Heart,
        keywords: ['like', 'heart', 'favorite', 'unlike'],
        shortcut: 'L',
        run: () => void library.setSaved({ type: 'track', id: track.id, title: track.title }, !track.liked),
      },
      { id: 'radio', label: `Start radio from “${track.title}”`, icon: Radio, keywords: ['station', 'similar'], run: () => controls.startRadio({ type: 'track', id: track.id }) },
      // The song menu's Songs that sound like this: a radio that keeps to the song's sound.
      { id: 'sonic-radio', label: `Songs that sound like “${track.title}”`, icon: AudioWaveform, keywords: ['sonic', 'radio', 'similar sound'], run: () => controls.startRadio({ type: 'sonic', id: track.id }) },
      ...(track.album ? [{ id: 'go-album', label: `Go to “${track.album.title}”`, icon: Disc3, keywords: ['album of the song playing'], run: () => void navigate(`/album/${track.album!.id}`) }] : []),
      ...track.artists.map(artist => ({ id: `go-artist:${artist.id}`, label: `Go to ${artist.name}`, icon: MicVocal, keywords: ['artist of the song playing'], run: () => void navigate(`/artist/${artist.id}`) })),
    ] : []),
    // The session's sleep timer, where the server takes one: each length and end, and off.
    ...(state.canSetSleepTimer ? [
      ...sleepTimerChoices(state.context).map(choice => ({
        id: `sleep:${choice.id}`,
        label: `Sleep timer: ${choice.label}`,
        icon: Moon,
        keywords: ['sleep', 'stop playing', 'timer'],
        run: () => controls.setSleepTimer(choice.request),
      })),
      ...(state.sleepTimer ? [{ id: 'sleep:off', label: 'Turn off the sleep timer', icon: TimerOff, keywords: ['sleep', 'timer'], run: () => controls.setSleepTimer(null) }] : []),
    ] : []),
    { id: 'queue', label: shell.queueOpen ? 'Hide queue' : 'Show queue', icon: ListMusic, keywords: ['up next'], shortcut: 'Q', run: shell.toggleQueue },
    { id: 'lyrics', label: shell.lyricsOpen ? 'Hide lyrics' : 'Show lyrics', icon: MessageSquareQuote, keywords: ['words', 'karaoke'], shortcut: 'Y', disabled: none, run: shell.toggleLyrics },
    { id: 'now-playing', label: 'Open Now Playing', icon: Maximize2, keywords: ['full screen', 'player'], disabled: none, run: shell.openNowPlaying },
    ...(shell.togglePopOut ? [{ id: 'pop-out', label: shell.poppedOut ? 'Close pop-out player' : 'Pop out player', icon: PictureInPicture2, keywords: ['picture in picture', 'mini player', 'window'], run: shell.togglePopOut }] : []),
    ...targets.map(device => ({ id: `device:${device.id}`, label: `Play on ${labelDevice(state, device).name}`, icon: MonitorSpeaker, keywords: ['switch device', 'transfer', 'speaker'], run: () => controls.transfer(device.id) })),
    { id: 'clear-queue', label: 'Clear queue', icon: ListX, keywords: ['empty up next'], disabled: !state.queue.length, run: controls.clearQueue },
    { id: 'new-playlist', label: 'New playlist', icon: ListPlus, keywords: ['create playlist'], run: () => library.newPlaylist() },
    { id: 'sidebar', label: 'Fold or unfold the sidebar', icon: PanelLeft, keywords: ['collapse', 'expand', 'toggle sidebar'], shortcut: `${mod}B`, run: shell.toggleSidebar },
    { id: 'settings', label: 'Open settings', icon: Settings, keywords: ['preferences', 'options'], shortcut: `${mod},`, run: () => shell.openSettings() },
    ...settingsSections.map(({ section, label }) => ({ id: `settings:${section}`, label: `${label} settings`, icon: Settings, keywords: ['preferences'], run: () => shell.openSettings(section) })),
    { id: 'shortcuts', label: 'Keyboard shortcuts', icon: Keyboard, keywords: ['keys', 'help', 'hotkeys'], shortcut: '?', run: shell.showShortcuts },
  ]
  // In someone's jam the host controls what plays, so the palette leaves out what the player dims.
  return rights.transport ? commands : commands.filter(command => !hostOnlyCommands.test(command.id))
}

/** The commands only a jam's host may run: playback, its modes, the radios, the sleep timer and clearing the queue. */
const hostOnlyCommands = /^(play-pause|next|previous|shuffle|repeat|autoplay|radio|sonic-radio|clear-queue|sleep:.*)$/
