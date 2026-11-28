import { hasVersions, plural, versionDetail, versionQuality, versionSongs, versionTitle } from '@squirmy/client-core'
import { queryKeys, type AlbumDetail } from '@squirmy/contracts'
import { useQueryClient } from '@tanstack/react-query'
import { ChevronDown, Layers } from 'lucide-react'
import { useApi } from '@/api/services'
import { Button } from '@/components/ui/button'
import { DropdownMenu, type MenuEntry } from '@/components/ui/menu'
import { usePlayerControls } from '@/player/player-context'

/**
 * The Versions control of an album page: which of the editions the server holds (the 1973 LP,
 * the 2011 remaster in FLAC, the same as MP3) plays by default for this user, on every device.
 * Automatic lists the album's own edition and plays each song from its best copy. A pick
 * changes the songs listed when the editions differ, and what plays from the next song on.
 * Only for albums the server holds two versions of.
 */
export function VersionsMenu({ album }: { album: Pick<AlbumDetail, 'id' | 'title' | 'ownedVersions' | 'versionId'> }) {
  const api = useApi()
  const queryClient = useQueryClient()
  const controls = usePlayerControls()
  if (!hasVersions(album)) return null
  const versions = album.ownedVersions!
  const picked = album.versionId ?? null
  // The menu stays open, busy, until the server has the pick and the page has the songs it lists.
  const choose = async (versionId: string | null) => {
    if (versionId === picked) return
    await (versionId === null ? api.catalog.clearVersion('album', album.id) : api.catalog.pickVersion('album', album.id, versionId))
    controls.forgetPlayback()
    await queryClient.invalidateQueries({ queryKey: queryKeys.album(album.id) })
  }
  const entries: MenuEntry[] = [
    { kind: 'label', label: 'Plays by default' },
    { label: 'Automatic', detail: ['The best copy of each song'], checked: picked === null, onSelect: () => choose(null) },
    { kind: 'separator' },
    ...versions.map((version): MenuEntry => ({
      label: versionTitle(version),
      detail: [`${versionQuality(version.quality)} · ${versionSongs(version)}`, ...(versionDetail(version) ? [versionDetail(version)!] : [])],
      checked: picked === version.id,
      onSelect: () => choose(version.id),
    })),
  ]
  return (
    <DropdownMenu
      align="start"
      contentClassName="w-80"
      entries={entries}
      trigger={(
        <Button variant="ghost" size="lg" className="px-3 text-muted-foreground hover:text-foreground" aria-label={`Versions of ${album.title}`}>
          <Layers className="size-5" />
          {plural(versions.length, 'version')}
          <ChevronDown className="opacity-60" />
        </Button>
      )}
    />
  )
}
