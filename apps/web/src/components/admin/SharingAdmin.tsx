import type { ServerSettings, SharePlayback, ShareLink, UpdateServerSettings } from '@squirmy/contracts'
import { Link2 } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { ShareLinkLabel } from '@/components/share/share-links'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/dialog'
import { EmptyState, Skeleton } from '@/components/ui/feedback'
import { Section } from '@/components/ui/section'
import { Select, type SelectOption } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { formatDate, formatRelative, plural } from '@/lib/format'
import { AdminHeader } from './AdminLayout'
import { SaveStatus, type SavePatch, type SaveState } from './DraftField'
import { DataTable, Panel, SettingRow, Td, Th, Tr } from './Panel'

const playbackOptions: SelectOption<SharePlayback>[] = [
  { value: 'previews', label: '30-second previews' },
  { value: 'full', label: 'Whole songs' },
  { value: 'off', label: 'No audio' },
]

type SharingAdminProps = {
  /** Undefined while loading. */
  settings: ServerSettings | undefined
  onSave: SavePatch<UpdateServerSettings>
  status: SaveState
  /** Everyone's links, newest first; undefined while loading. */
  links: ShareLink[] | undefined
  /** More links than are listed: the list loads the next page. */
  onLoadMore?: () => void
  loadingMore?: boolean
  onRevoke: (id: string) => Promise<unknown>
  /** Said in place of a part when its first read failed. */
  failures?: Partial<Record<'settings' | 'links', ReactNode>>
}

/** Whether members can make public links, what those links play, and every link there is. */
export function SharingAdmin({ settings, onSave, status, links, onLoadMore, loadingMore, onRevoke, failures }: SharingAdminProps) {
  const [revoking, setRevoking] = useState<ShareLink | null>(null)
  return (
    <div>
      <AdminHeader title="Sharing" description="Members can make public links to albums, playlists and songs. Anyone with a link sees a page with the songs, without an account.">
        <SaveStatus status={status} />
      </AdminHeader>

      <div className="flex flex-col gap-7">
        {settings ? (
          <Section title="Links">
            <SettingRow label="Share links" description="Off, every link stops working at once but is kept, so turning it back on brings them back.">
              {save => <Switch aria-label="Share links" checked={settings.sharingEnabled} onCheckedChange={value => void save(() => onSave({ sharingEnabled: value }))} />}
            </SettingRow>
            <SettingRow label="What a shared page plays" description="Previews are cut on the server, so a listener cannot get more than 30 seconds. Only music this server holds plays.">
              {save => (
                <Select label="What a shared page plays" className="w-52 max-w-full" value={settings.sharePlayback} options={playbackOptions} onValueChange={value => void save(() => onSave({ sharePlayback: value }))} />
              )}
            </SettingRow>
          </Section>
        ) : failures?.settings ?? <Skeleton className="h-28 w-full rounded-xl" />}

        <Panel title="Every link" description="Revoking one stops it for everyone who has it. Its creator sees the change in their settings.">
          {!links && (failures?.links ?? <Skeleton className="h-40 w-full rounded-xl" />)}
          {links?.length === 0 && <EmptyState icon={<Link2 />} title="No share links yet" description="Members make them from the menu of an album, playlist or song." />}
          {links && links.length > 0 && (
            <DataTable>
              <thead><tr className="border-b"><Th>Shared</Th><Th>By</Th><Th>Created</Th><Th>Expires</Th><Th>Opened</Th><Th><span className="sr-only">Actions</span></Th></tr></thead>
              <tbody>
                {links.map(link => (
                  <Tr key={link.id}>
                    <Td className="max-w-64"><ShareLinkLabel link={link} /></Td>
                    <Td className="whitespace-nowrap text-muted-foreground">{link.createdBy?.username ?? '—'}</Td>
                    <Td className="whitespace-nowrap text-muted-foreground">{formatDate(link.createdAt)}</Td>
                    <Td className="whitespace-nowrap text-muted-foreground">{link.expiresAt === null ? 'Never' : link.expired ? `Expired ${formatDate(link.expiresAt)}` : formatRelative(link.expiresAt)}</Td>
                    <Td className="whitespace-nowrap text-muted-foreground">{link.openCount === 0 ? 'Never' : plural(link.openCount, 'time')}</Td>
                    <Td className="text-right"><Button size="sm" variant="outline" onClick={() => setRevoking(link)}>Revoke</Button></Td>
                  </Tr>
                ))}
              </tbody>
            </DataTable>
          )}
          {onLoadMore && <Button variant="outline" size="sm" className="self-start" pending={loadingMore} onClick={onLoadMore}>Show more</Button>}
        </Panel>
      </div>

      <ConfirmDialog
        open={!!revoking}
        onOpenChange={next => { if (!next) setRevoking(null) }}
        title={`Revoke the link to “${revoking?.title}”?`}
        description={`It stops working for everyone who has it${revoking?.createdBy ? `, and leaves ${revoking.createdBy.username}’s list` : ''}.`}
        confirmLabel="Revoke"
        onConfirm={() => onRevoke(revoking!.id)}
      />
    </div>
  )
}
