import { creditGroups } from '@squirmy/client-core'
import type { TrackSummary } from '@squirmy/contracts'
import { ArrowDown, ArrowUp, AudioWaveform, Check, Disc3, ListEnd, ListMusic, ListPlus, ListStart, MicVocal, Play, Plus, Radio, Share2, Star, StarOff, Trash2, Users } from 'lucide-react'
import type { MenuEntry } from '@/components/ui/menu'
import type { JamRights } from '@/player/player-context'
import { librarySaveEntry, wantEntry } from './library-save-entry'
import type { PlaylistChoice, TrackAction } from './TrackList'
import type { BatchAction } from './track-selection'

export type TrackMenuOptions = {
  unavailable: boolean
  /** Undefined while the server has the wantlist off. */
  wanted?: boolean
  playlists?: PlaylistChoice[]
  /** Offers 1 to 5 stars (the user turned ratings on); the song's own is checked. */
  ratings?: boolean
  /** Resolves (or rejects) for the actions that answer later, which their entries wait for. */
  act: (action: TrackAction) => void | Promise<unknown>
  navigate: (to: string) => void
  /** The server lets members make public links: Share makes one to the song. */
  canShare?: boolean
  extraMenu?: MenuEntry[]
  /** The row's place in a list the user may reorder. */
  reorder?: { index: number; count: number }
  /** The song is listed on its own album's page, so "Go to album" would lead where it already is. */
  onAlbumPage?: boolean
  /**
   * The song's place in Up next, where it is queued already. As in the iOS app, Play next then
   * moves it to the front and Move to end (for Add to queue) to the end, and a move that would
   * leave it where it is is left out.
   */
  queued?: { index: number; count: number }
  /**
   * What the listener may do, in someone's jam (`useJamRights`): Play next and Add to queue
   * wait for its queue policy, a queued song's moves are the host's, and so are the radios,
   * which replace what plays. Everything, when left out.
   */
  rights?: Pick<JamRights, 'transport' | 'add' | 'reorder'>
}

export function trackCreditEntries(track: TrackSummary, navigate: TrackMenuOptions['navigate']): MenuEntry[] {
  return creditGroups(track.credits).flatMap(({ label, credits }): MenuEntry[] => [
    { kind: 'label', label },
    ...credits.map(({ artist, name }) => ({ label: name, onSelect: () => navigate(`/artist/${artist.id}`) })),
  ])
}

/**
 * A song's menu, the same wherever a song is listed (track lists, search results): on a touch
 * screen its whole title and credit, then play next, queue, playlists, the radios, saving it (the heart), the Wantlist, its album and artists.
 */
export function trackMenuEntries(track: TrackSummary, { unavailable, wanted, playlists, ratings, act, navigate, canShare = false, extraMenu, reorder, onAlbumPage = false, queued, rights }: TrackMenuOptions): MenuEntry[] {
  const unqueueable = unavailable || rights?.add === false
  const unmovable = queued && rights?.reorder === false
  const playNext: MenuEntry[] = unmovable || (queued && queued.index === 0) ? [] : [{ label: 'Play next', icon: <ListStart />, onSelect: () => act('play-next'), done: 'Playing next', disabled: unqueueable }]
  const toEnd: MenuEntry[] = unmovable ? [] : !queued
    ? [{ label: 'Add to queue', icon: <ListEnd />, onSelect: () => act('enqueue'), done: 'Added to queue', disabled: unqueueable }]
    : queued.index < queued.count - 1 ? [{ label: 'Move to end', icon: <ListEnd />, onSelect: () => act('enqueue'), done: 'Moved to end', disabled: unqueueable }] : []
  const noRadio = unavailable || rights?.transport === false
  const credits = trackCreditEntries(track, navigate)
  return [
    // On a touch screen the menu opens with the song's whole title and credit, which its row cuts short.
    { kind: 'header', label: track.title, detail: track.artistCredit },
    // The queue may be out of sight: the entry says it worked.
    ...playNext,
    ...toEnd,
    ...(playlists ? [{
      kind: 'submenu' as const,
      label: 'Add to playlist',
      icon: <ListPlus />,
      items: [
        { label: 'New playlist…', icon: <Plus />, onSelect: () => act('add-to:new') },
        ...(playlists.length ? [{ kind: 'separator' as const }] : []),
        ...playlists.map(playlist => ({ label: playlist.name, icon: <ListMusic />, onSelect: () => act(`add-to:${playlist.id}`), done: `Added to ${playlist.name}` })),
      ],
    }] : []),
    { label: 'Start radio', icon: <Radio />, onSelect: () => act('radio'), disabled: noRadio },
    // Leans on how the song sounds (the server's sonic analysis) more than on who made it.
    { label: 'Songs that sound like this', icon: <AudioWaveform />, onSelect: () => act('sonic-radio'), disabled: noRadio },
    ...(canShare ? [{ label: 'Share…', icon: <Share2 />, onSelect: () => act('share') }] : []),
    { kind: 'separator' },
    librarySaveEntry(track, () => act('like')),
    ...(ratings ? [ratingEntry(track, act)] : []),
    // Undefined `wanted` means the server has the wantlist off. It is for music that does not play.
    ...(!unavailable || wanted === undefined ? [] : [wantEntry(wanted, () => act('want'))]),
    { kind: 'separator' },
    ...(track.album && !onAlbumPage ? [{ label: 'Go to album', icon: <Disc3 />, onSelect: () => navigate(`/album/${track.album!.id}`) }] : []),
    ...track.artists.map(artist => ({ label: track.artists.length > 1 ? `Go to ${artist.name}` : 'Go to artist', icon: <MicVocal />, onSelect: () => navigate(`/artist/${artist.id}`) })),
    ...(credits.length ? [{ kind: 'submenu' as const, label: 'Credits', icon: <Users />, items: credits }] : []),
    ...(extraMenu ?? []),
    ...(reorder ? [
      { kind: 'separator' as const },
      { label: 'Move up', icon: <ArrowUp />, disabled: reorder.index === 0, onSelect: () => act('move-up') },
      { label: 'Move down', icon: <ArrowDown />, disabled: reorder.index === reorder.count - 1, onSelect: () => act('move-down') },
      { label: 'Remove from playlist', icon: <Trash2 />, danger: true, onSelect: () => act('remove') },
    ] : []),
  ]
}

/** What a rating reads as in the menu and to screen readers. */
const starsLabel = (stars: number) => (stars === 1 ? '1 star' : `${stars} stars`)

/** "Rating: 4 stars": a submenu of 5 to 1 stars, the song's own checked, and No rating once it has one. */
function ratingEntry(track: TrackSummary, act: TrackMenuOptions['act']): MenuEntry {
  const current = track.rating ?? 0
  return {
    kind: 'submenu',
    label: current ? `Rating: ${starsLabel(current)}` : 'Rating',
    icon: <Star />,
    items: [
      ...[5, 4, 3, 2, 1].map(stars => ({
        label: starsLabel(stars),
        icon: stars === current ? <Check /> : <Star />,
        onSelect: () => act(`rate:${stars}`),
      })),
      ...(current ? [{ kind: 'separator' as const }, { label: 'No rating', icon: <StarOff />, onSelect: () => act('rate:0') }] : []),
    ],
  }
}

export type SelectionMenuOptions = {
  /** None of the songs plays here: nothing to play or queue. */
  unavailable: boolean
  playlists?: PlaylistChoice[]
  act: (action: BatchAction) => void | Promise<unknown>
  /** What Remove takes them out of (the playlist the user owns, the queue); none where they cannot be removed. */
  remove?: string
}

/** The words for `count` songs. */
export const songsLabel = (count: number) => `${count.toLocaleString()} ${count === 1 ? 'song' : 'songs'}`

/**
 * The menu of several picked songs, from a right-click on one of them and the selection bar's
 * More: what a song's menu offers that makes sense for many at once.
 */
export function selectionMenuEntries(tracks: TrackSummary[], { unavailable, playlists, act, remove }: SelectionMenuOptions): MenuEntry[] {
  const allSaved = tracks.every(track => track.liked)
  return [
    { kind: 'label', label: `${songsLabel(tracks.length)} selected` },
    { label: 'Play', icon: <Play />, onSelect: () => act('play'), disabled: unavailable },
    { label: 'Play next', icon: <ListStart />, onSelect: () => act('play-next'), done: 'Playing next', disabled: unavailable },
    { label: 'Add to queue', icon: <ListEnd />, onSelect: () => act('enqueue'), done: 'Added to queue', disabled: unavailable },
    ...(playlists ? [{
      kind: 'submenu' as const,
      label: 'Add to playlist',
      icon: <ListPlus />,
      items: [
        { label: 'New playlist…', icon: <Plus />, onSelect: () => act('add-to:new') },
        ...(playlists.length ? [{ kind: 'separator' as const }] : []),
        ...playlists.map(playlist => ({ label: playlist.name, icon: <ListMusic />, onSelect: () => act(`add-to:${playlist.id}`), done: `Added to ${playlist.name}` })),
      ],
    }] : []),
    { kind: 'separator' },
    librarySaveEntry({ liked: allSaved }, () => act(allSaved ? 'unsave' : 'save')),
    ...(remove ? [
      { kind: 'separator' as const },
      { label: `Remove from ${remove}`, icon: <Trash2 />, danger: true, onSelect: () => act('remove') },
    ] : []),
  ]
}
