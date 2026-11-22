import type { DirectoryListing, Import, ImportAlbum, ImportOptions, LibraryRoot, TrackSummary } from '@squirmy/contracts'
import { Bell, Check, Heart, Inbox, MoreHorizontal, Play, Plus, Settings, Shuffle, Trash2 } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { LoginView, RegisterView, SetupAccountView, SetupDoneView, SetupLibraryView, SplashView, UnreachableView } from '@/components/auth/AuthViews'
import { FolderPicker } from '@/components/auth/FolderPicker'
import { ImportDetail } from '@/components/imports/ImportDetail'
import { ImportsList } from '@/components/imports/ImportsList'
import { NotTaken, UploadPanel } from '@/components/imports/UploadPanel'
import { Page, PageHeader, PageTitle } from '@/components/layout/Page'
import { AlbumCard, ArtistCard, CardGrid, GenreTile, PlaylistCard } from '@/components/music/Cards'
import { LikedCover, PlaylistCover } from '@/components/music/CollectionArt'
import { Cover } from '@/components/music/Cover'
import { Equalizer } from '@/components/music/Equalizer'
import { Rail, RailItem } from '@/components/music/Rail'
import { SectionHeader } from '@/components/music/SectionHeader'
import { TrackList, TrackRow, type NowPlaying } from '@/components/music/TrackList'
import { DeviceList, PlayingElsewhere } from '@/components/player/Devices'
import { LyricsPane } from '@/components/player/Lyrics'
import { MiniPlayer, PlayerBar } from '@/components/player/PlayerBar'
import { QueueContent } from '@/components/player/Queue'
import { Button } from '@/components/ui/button'
import { CopyField } from '@/components/ui/copy-field'
import { ConfirmDialog, Dialog, DialogClose, DialogContent, DialogFooter, DialogTrigger } from '@/components/ui/dialog'
import { Badge, EmptyState, ExplicitBadge, Kbd, ProgressBar, Separator, Skeleton, Spinner } from '@/components/ui/feedback'
import { IconButton } from '@/components/ui/icon-button'
import { Field, FormError, Input, Textarea } from '@/components/ui/input'
import { ContextMenu, DropdownMenu, type MenuEntry } from '@/components/ui/menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ScrollArea } from '@/components/ui/scroll-area'
import { SearchField } from '@/components/ui/search-field'
import { Row, Section } from '@/components/ui/section'
import { Select } from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip } from '@/components/ui/tooltip'
import { album, albums, artists, lyricsFor, playlistSummaries, summary, track } from '@/fixtures/catalog'
import { FixtureProviders } from '@/fixtures/FixtureProviders'
import { setAppearanceMode, setColorTheme, useAppearance } from '@/lib/appearance'
import { COLOR_THEMES } from '@/lib/color-themes'
import { toast } from '@/lib/toast'
import type { UploadFileState, UploadSnapshot } from '@/lib/upload'
import { cn } from '@/lib/utils'
import { usePlayer } from '@/player/player-context'

/** Each surface token with the text color that goes on it, then the line colors. */
const swatches: [name: string, text?: string][] = [
  ['background', 'foreground'], ['card', 'card-foreground'], ['popover', 'popover-foreground'], ['primary', 'primary-foreground'],
  ['secondary', 'secondary-foreground'], ['muted', 'muted-foreground'], ['accent', 'accent-foreground'], ['destructive', 'destructive-foreground'],
  ['sidebar', 'sidebar-foreground'], ['sidebar-accent', 'sidebar-accent-foreground'], ['border'], ['input'], ['ring'], ['sidebar-border'],
]

const buttonVariants = ['primary', 'secondary', 'outline', 'ghost', 'danger', 'link'] as const
const buttonSizes = ['sm', 'md', 'lg'] as const
const iconVariants = ['ghost', 'solid', 'outline', 'primary', 'contrast'] as const
const iconSizes = ['xs', 'sm', 'md', 'lg', 'xl'] as const
const capitalize = (word: string) => word[0].toUpperCase() + word.slice(1)

const sortOptions = [{ value: 'recent', label: 'Recently added' }, { value: 'title', label: 'Title' }, { value: 'artist', label: 'Artist' }] as const
type Sort = (typeof sortOptions)[number]['value']

const menu: MenuEntry[] = [
  { kind: 'label', label: 'Night Swimming' },
  { label: 'Play next', icon: <Shuffle />, shortcut: '⌘N', onSelect: () => toast({ title: 'Playing next' }) },
  { label: 'Save to Liked Songs', icon: <Heart />, onSelect: () => toast({ title: 'Saved' }) },
  { kind: 'submenu', label: 'Add to playlist', icon: <Plus />, items: playlistSummaries.map(playlist => ({ label: playlist.name, onSelect: () => toast({ title: `Added to ${playlist.name}` }) })) },
  { kind: 'separator' },
  { label: 'Disabled item', onSelect: () => {}, disabled: true },
  { label: 'Delete', icon: <Trash2 />, danger: true, onSelect: () => toast({ title: 'Deleted' }) },
]

// Fixtures for the pages that add music and for the pages before sign-in.

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
const megabytes = (count: number) => count * 1024 ** 2

const counts: Import['counts'] = {
  filesReceived: 14, bytesReceived: megabytes(412), filesRejected: 1, filesExtracted: 0, archivesRejected: 0, audioFiles: 13, duplicatesSkipped: 2, unreadable: 0,
  albumsIdentified: 2, albumsFiled: 1, filesFiled: 9, filesLeftForReview: 2,
}

function importFixture(id: string, patch: Partial<Import>): Import {
  return {
    id, kind: 'upload', status: 'completed', step: null, label: 'Blue Hour', userId: null, acquisitionJobId: null, targetRootId: null, counts, timedOut: false,
    reviewFolder: null, error: null, createdAt: minutesAgo(42), updatedAt: minutesAgo(40), completedAt: minutesAgo(40), ...patch,
  }
}

const imports: Import[] = [
  importFixture('receiving', { status: 'receiving', label: 'Glass City', createdAt: minutesAgo(1), completedAt: null, counts: { ...counts, filesReceived: 6, bytesReceived: megabytes(180) } }),
  importFixture('identifying', { kind: 'inbox', status: 'processing', step: 'identifying', label: 'Low Tide.zip', createdAt: minutesAgo(6), completedAt: null }),
  importFixture('done', {}),
  importFixture('fetched', { kind: 'acquisition', label: 'Every Shape', createdAt: minutesAgo(180), completedAt: minutesAgo(176), counts: { ...counts, filesRejected: 0, duplicatesSkipped: 0, albumsIdentified: 1, filesLeftForReview: 0 } }),
  importFixture('cancelled', { status: 'failed', error: 'Cancelled', label: 'Static Bloom', createdAt: minutesAgo(26 * 60), completedAt: null }),
  importFixture('failed', { status: 'failed', error: 'The music folder has no room left', label: 'Live at the Glasshouse', createdAt: minutesAgo(50 * 60), completedAt: null }),
]

const importAlbums: ImportAlbum[] = [
  { album: summary(album('blue-hour')), files: 9, filed: true },
  { album: summary(album('low-tide')), files: 2, filed: false },
]

const importOptions: ImportOptions = { unavailable: null, maxFileBytes: 4 * 1024 ** 3, maxBytes: 64 * 1024 ** 3 }

const uploadFiles: UploadFileState[] = [
  { path: 'Blue Hour/01 Night Swimming.flac', size: megabytes(31), sent: megabytes(31), status: 'accepted', reason: null },
  { path: 'Blue Hour/02 Blue in the Dark.flac', size: megabytes(28), sent: megabytes(11), status: 'sending', reason: null },
  { path: 'Blue Hour/03 Soft Signal.flac', size: megabytes(26), sent: 0, status: 'waiting', reason: null },
  { path: 'Blue Hour/04 After the Rain.flac', size: megabytes(34), sent: 0, status: 'waiting', reason: null },
  { path: 'Blue Hour/notes.txt', size: 2048, sent: 0, status: 'rejected', reason: 'unsupported_type' },
  { path: 'Low Tide.zip', size: megabytes(120), sent: 0, status: 'waiting', reason: null },
]
const uploadBytes = uploadFiles.reduce((sum, file) => sum + (file.status === 'rejected' ? 0 : file.size), 0)

const uploadStates = ['Drop zone', 'Reading', 'Ready', 'Uploading', 'Paused', 'Stopped', 'No folder, admin', 'No folder, member'] as const
type UploadState = (typeof uploadStates)[number]

function uploadSnapshot(state: UploadState): UploadSnapshot | null {
  if (state === 'Ready') return { phase: 'ready', files: uploadFiles.map(file => (file.status === 'rejected' ? file : { ...file, sent: 0, status: 'waiting' as const })), totalBytes: uploadBytes, sentBytes: 0, import: null, error: null }
  const phase = state === 'Uploading' ? 'sending' : state === 'Paused' ? 'paused' : state === 'Stopped' ? 'failed' : null
  if (!phase) return null
  const files = phase === 'sending' ? uploadFiles : uploadFiles.map(file => (file.status === 'sending' ? { ...file, status: 'waiting' as const } : file))
  return { phase, files, totalBytes: uploadBytes, sentBytes: megabytes(42), import: null, error: phase === 'failed' ? 'The connection to the server was lost.' : null }
}

const roots: LibraryRoot[] = [
  {
    id: 'root-music', name: 'Music', path: '/srv/music', mode: 'read_only', enabled: true, watch: true, template: null, scanning: false, fileCount: 4812,
    lastScanStartedAt: minutesAgo(190), lastScanFinishedAt: minutesAgo(184), lastScanStats: null,
  },
  {
    id: 'root-uploads', name: 'Uploads', path: '/srv/media/library/uploads', mode: 'managed', enabled: true, watch: true, template: null, scanning: true, fileCount: 212,
    lastScanStartedAt: minutesAgo(1), lastScanFinishedAt: null, lastScanStats: null,
  },
]

/** A made-up server disk: every folder holds the same few folders. */
function listingOf(path: string): DirectoryListing {
  const here = path === '/' ? '' : path
  return { path, parent: path === '/' ? null : path.slice(0, path.lastIndexOf('/')) || '/', directories: ['Downloads', 'Music', 'Podcasts', 'Recordings'].map(name => ({ name, path: `${here}/${name}` })) }
}

const pickerStates: { label: string; path: string; listing: DirectoryListing | undefined; error?: string }[] = [
  { label: 'folders', path: '/srv', listing: listingOf('/srv') },
  { label: 'loading', path: '/srv/music', listing: undefined },
  { label: 'empty', path: '/srv/music/empty', listing: { path: '/srv/music/empty', parent: '/srv/music', directories: [] } },
  { label: 'refused', path: '/root', listing: undefined, error: 'No such directory' },
]

const authViews = ['Sign in page', 'Register page', 'Setup: account', 'Setup: music', 'Setup: first folder', 'Setup: done', 'Unreachable', 'Splash'] as const
type AuthView = (typeof authViews)[number]

const later = () => new Promise<void>(resolve => { setTimeout(resolve, 600) })

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4">
      <h2 className="border-b pb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{title}</h2>
      {children}
    </section>
  )
}

function Line({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('flex flex-wrap items-center gap-3', className)}>{children}</div>
}

/** A row of buttons that picks which state of something is on screen. */
function Chooser<T extends string>({ label, options, value, onChange }: { label: string; options: readonly T[]; value: T | null; onChange: (value: T) => void }) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-1.5">
      {options.map(option => <Button key={option} size="sm" variant={option === value ? 'secondary' : 'outline'} aria-pressed={option === value} onClick={() => onChange(option)}>{option}</Button>)}
    </div>
  )
}

/** Every primitive and component state on one page, for design review, on the fixture catalog and session. */
export function KitchenSinkPage() {
  return <FixtureProviders><KitchenSink /></FixtureProviders>
}

function KitchenSink() {
  const appearance = useAppearance()
  return (
    <>
      <PageHeader title="Kitchen sink">
        <Select size="sm" label="Appearance" value={appearance.mode} onValueChange={setAppearanceMode} options={[{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} />
        <Select size="sm" label="Color theme" value={appearance.theme} onValueChange={setColorTheme} options={COLOR_THEMES.map(theme => ({ value: theme.id, label: theme.name }))} />
      </PageHeader>
      <Page className="flex max-w-6xl flex-col gap-10">
        <p className="text-sm text-muted-foreground">Every primitive and component state, on made-up music. Switch the appearance and the color theme above to check them all.</p>
        <Foundations />
        <Controls />
        <Surfaces />
        <Overlays />
        <Music />
        <AddingMusic />
        <BeforeSignIn />
      </Page>
    </>
  )
}

function Foundations() {
  return (
    <>
      <Group title="Palette">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
          {swatches.map(([name, text]) => (
            <div key={name} className="flex flex-col gap-1.5">
              <div className="flex h-12 items-center justify-center rounded-lg border text-sm font-medium" style={{ background: `var(--${name})`, color: text ? `var(--${text})` : undefined }}>{text && 'Aa'}</div>
              <span className="truncate font-mono text-xs text-muted-foreground">{name}</span>
            </div>
          ))}
        </div>
      </Group>

      <Group title="Type">
        <p className="text-3xl font-semibold tracking-tight text-balance md:text-4xl">Hero title</p>
        <PageTitle>Page title</PageTitle>
        <SectionHeader title="Section heading" href="/" className="mb-0" />
        <div>
          <p className="text-sm font-medium">Card title</p>
          <p className="text-xs text-muted-foreground">Card subtitle · 7 songs, 34 min</p>
        </div>
        <p className="max-w-xl text-sm">Body text. Soft-focus synths and close-mic vocals trace the last light of the day.</p>
        <p className="max-w-xl text-sm text-muted-foreground">Secondary text, for descriptions and everything that explains.</p>
        <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Small caps label</p>
      </Group>
    </>
  )
}

function Controls() {
  const [slider, setSlider] = useState(40)
  const [query, setQuery] = useState('Blue hour')
  const [sort, setSort] = useState<Sort>('recent')
  const [checked, setChecked] = useState(true)
  const [pressed, setPressed] = useState(true)
  return (
    <>
      <Group title="Buttons">
        {buttonSizes.map(size => (
          <Line key={size}>
            <span className="w-6 font-mono text-xs text-muted-foreground">{size}</span>
            {buttonVariants.map(variant => <Button key={variant} variant={variant} size={size}>{capitalize(variant)}</Button>)}
          </Line>
        ))}
        <Line>
          <Button variant="primary"><Plus />With an icon</Button>
          <Button variant="outline"><Settings />Outline</Button>
          <Button variant="primary" pending>Pending</Button>
          <Button variant="primary" disabled>Disabled</Button>
          <Button disabled>Disabled</Button>
          <Button variant="outline" asChild><Link to="/dev/engine">A link</Link></Button>
        </Line>
      </Group>

      <Group title="Icon buttons">
        <Line>
          {iconVariants.map(variant => <IconButton key={variant} label={capitalize(variant)} variant={variant}><Bell /></IconButton>)}
          <div className="relative w-14">
            <Cover artwork={album('glass-city').artwork} size={96} />
            <IconButton label="Glass" variant="glass" size="sm" shape="round" className="absolute inset-0 m-auto"><MoreHorizontal /></IconButton>
          </div>
          <IconButton label="Toggle" pressed={pressed} onClick={() => setPressed(!pressed)}><Shuffle /></IconButton>
          <IconButton label="Disabled" disabled><Trash2 /></IconButton>
        </Line>
        <Line>
          {iconSizes.map(size => <IconButton key={size} label={`Size ${size}`} size={size} variant="outline"><Settings /></IconButton>)}
          <Separator orientation="vertical" className="h-6" />
          {iconSizes.map(size => <IconButton key={size} label={`Round, size ${size}`} size={size} shape="round" variant="primary"><Play fill="currentColor" /></IconButton>)}
        </Line>
      </Group>

      <Group title="Inputs">
        <div className="grid max-w-3xl items-start gap-5 md:grid-cols-2">
          <Field label="Text input" htmlFor="ks-input" hint="A hint under the field."><Input id="ks-input" placeholder="Placeholder" /></Field>
          <Field label="With an error" htmlFor="ks-error" error="That username is taken."><Input id="ks-error" defaultValue="alex" aria-invalid /></Field>
          <Field label="Disabled" htmlFor="ks-disabled"><Input id="ks-disabled" defaultValue="Cannot be changed" disabled /></Field>
          <Field label="Textarea" htmlFor="ks-textarea"><Textarea id="ks-textarea" placeholder="Grows with what you write" /></Field>
          <SearchField value={query} onValueChange={setQuery} placeholder="Songs, albums, artists" />
          <SearchField value={query} onValueChange={setQuery} size="lg" />
          <CopyField value="sq-4f9a-27c1-example" label="Example secret" />
          <FormError message="A failure of the whole form, such as a wrong password." />
        </div>
        <Line>
          <Select label="Sort" prefix="Sort:" value={sort} onValueChange={setSort} options={sortOptions} />
          <Select label="Small sort" size="sm" value={sort} onValueChange={setSort} options={sortOptions} />
          <Select label="Disabled sort" value={sort} onValueChange={setSort} options={sortOptions} disabled />
          <Switch aria-label="Example switch" checked={checked} onCheckedChange={setChecked} />
          <Switch aria-label="Disabled switch" disabled />
          <div className="w-64"><Slider label="Example slider" value={slider} max={100} onValueChange={setSlider} valueText={`${slider}%`} /></div>
          <div className="w-40"><Slider label="Disabled slider" value={60} max={100} onValueChange={() => {}} disabled /></div>
        </Line>
      </Group>
    </>
  )
}

function Surfaces() {
  const [sort, setSort] = useState<Sort>('recent')
  const [checked, setChecked] = useState(true)
  return (
    <>
      <Group title="Sections and rows">
        <div className="flex max-w-3xl flex-col gap-7">
          <Section title="A section" description="A titled card of rows, as in settings and the admin panel." action={<Button size="sm" variant="outline"><Plus />Add</Button>}>
            <Row htmlFor="ks-row-switch" label="A switch" description="What turning it on does, in a sentence.">
              <Switch id="ks-row-switch" checked={checked} onCheckedChange={setChecked} />
            </Row>
            <Row htmlFor="ks-row-select" label="A choice">
              <Select id="ks-row-select" label="A choice" value={sort} onValueChange={setSort} options={sortOptions} className="w-44" />
            </Row>
            <Row label="A value" description="Rows can also only say something."><Badge>Read-only</Badge></Row>
            <Row label="An action"><Button size="sm" variant="outline">Change</Button></Row>
          </Section>
          <Section title="A dangerous section" danger>
            <Row label="Delete everything" description="This cannot be undone."><Button size="sm" variant="danger">Delete</Button></Row>
          </Section>
        </div>
      </Group>

      <Group title="Feedback">
        <Line>
          <Badge>Neutral</Badge>
          <Badge tone="accent">Accent</Badge>
          <Badge tone="solid">Solid</Badge>
          <Badge tone="outline">Outline</Badge>
          <Badge tone="danger">Danger</Badge>
          <Badge><Check />With an icon</Badge>
          <ExplicitBadge />
          <Kbd>⌘K</Kbd>
          <Spinner />
          <Equalizer playing />
          <Equalizer playing={false} />
        </Line>
        <div className="flex max-w-md flex-col gap-3">
          <ProgressBar value={0.4} label="Example progress" />
          <ProgressBar value={null} label="Progress of unknown length" />
        </div>
        <Line>
          <Button variant="outline" onClick={() => toast({ title: 'Added to queue', description: 'Night Swimming', action: { label: 'Undo', onClick: () => {} } })}>Show toast</Button>
          <Button variant="outline" onClick={() => toast({ title: 'Saved' })}>Show a short toast</Button>
        </Line>
        <div className="flex max-w-md items-center gap-3">
          <Skeleton className="size-12" />
          <div className="flex flex-1 flex-col gap-2"><Skeleton className="h-4 w-2/3" /><Skeleton className="h-3 w-1/3" /></div>
        </div>
        <EmptyState icon={<Inbox />} title="Empty state" description="A sentence about why it is empty and what to do." action={<Button variant="primary">Do something</Button>} className="max-w-md rounded-xl border py-10" />
      </Group>
    </>
  )
}

function Overlays() {
  const player = usePlayer()
  const [confirming, setConfirming] = useState(false)
  return (
    <Group title="Overlays">
      <Line>
        <DropdownMenu entries={menu} align="start" trigger={<Button variant="outline"><MoreHorizontal />Dropdown menu</Button>} />
        <ContextMenu entries={menu}>
          <div className="flex h-9 items-center rounded-md border border-dashed border-input px-3 text-sm text-muted-foreground">Right-click here</div>
        </ContextMenu>
        <Tooltip label="A tooltip"><Button variant="outline">Hover for tooltip</Button></Tooltip>
        <Dialog>
          <DialogTrigger asChild><Button variant="outline">Open dialog</Button></DialogTrigger>
          <DialogContent title="A dialog" description="Dialogs trap focus and close on Escape.">
            <Field label="Name" htmlFor="ks-dialog"><Input id="ks-dialog" /></Field>
            <DialogFooter><DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose><DialogClose asChild><Button variant="primary">Save</Button></DialogClose></DialogFooter>
          </DialogContent>
        </Dialog>
        <Button variant="outline" onClick={() => setConfirming(true)}>Open confirmation</Button>
        <ConfirmDialog open={confirming} onOpenChange={setConfirming} title="Delete “After Dark”?" description="The playlist is deleted for everyone. Its songs stay in the library." confirmLabel="Delete" onConfirm={later} />
        <Popover>
          <PopoverTrigger asChild><Button variant="outline">Devices popover</Button></PopoverTrigger>
          <PopoverContent align="start"><DeviceList player={player} /></PopoverContent>
        </Popover>
      </Line>
      <Tabs defaultValue="songs">
        <TabsList><TabsTrigger value="songs">Songs</TabsTrigger><TabsTrigger value="albums">Albums</TabsTrigger><TabsTrigger value="artists">Artists</TabsTrigger></TabsList>
        <TabsContent value="songs" className="pt-3 text-sm text-muted-foreground">Songs tab</TabsContent>
        <TabsContent value="albums" className="pt-3 text-sm text-muted-foreground">Albums tab</TabsContent>
        <TabsContent value="artists" className="pt-3 text-sm text-muted-foreground">Artists tab</TabsContent>
      </Tabs>
      <ScrollArea className="h-36 max-w-sm rounded-xl border bg-card px-4 py-2">
        {albums.map(item => <p key={item.id} className="py-1 text-sm">{item.title} · <span className="text-muted-foreground">{item.artistCredit}</span></p>)}
      </ScrollArea>
    </Group>
  )
}

function Music() {
  const player = usePlayer()
  const states: { label: string; track: TrackSummary; nowPlaying?: NowPlaying }[] = [
    { label: 'In library', track: track('soft-signal') },
    { label: 'Playing', track: track('night-swimming'), nowPlaying: { trackId: track('night-swimming').id, playing: true, preparing: false, onTogglePlay: () => {} } },
    { label: 'Paused', track: track('blue-in-the-dark'), nowPlaying: { trackId: track('blue-in-the-dark').id, playing: false, preparing: false, onTogglePlay: () => {} } },
    { label: 'Preparing', track: track('night-swimming-demo'), nowPlaying: { trackId: track('night-swimming-demo').id, playing: true, preparing: true, onTogglePlay: () => {} } },
    { label: 'On demand', track: track('low-tide-song') },
    { label: 'Not in library', track: track('soft-signal-live') },
    { label: 'Explicit', track: track('after-the-rain') },
  ]
  return (
    <>
      <Group title="Artwork">
        <Line className="items-start">
          {[
            ['Loaded', <Cover key="a" artwork={album('glass-city').artwork} />],
            ['Round', <Cover key="b" artwork={album('every-shape').artwork} round />],
            ['Not owned', <Cover key="c" artwork={album('live-glasshouse').artwork} dimmed />],
            ['No artwork', <Cover key="d" artwork={null} />],
            ['Failed to load', <Cover key="e" artwork={{ id: 'missing', color: '#4a4d71', thumbhash: null }} artUrl={() => '/missing-cover.jpg'} />],
            ['Mosaic', <PlaylistCover key="f" artworks={playlistSummaries[0].artworks} />],
            ['Empty playlist', <PlaylistCover key="g" artworks={[]} />],
            ['Liked', <LikedCover key="h" />],
          ].map(([label, node]) => (
            <figure key={label as string} className="flex w-28 flex-col gap-1.5">{node}<figcaption className="text-xs text-muted-foreground">{label}</figcaption></figure>
          ))}
        </Line>
      </Group>

      <Group title="Cards">
        <CardGrid>
          <AlbumCard album={summary(album('glass-city'))} onPlay={() => {}} />
          <AlbumCard album={summary(album('blue-hour'))} onPlay={() => {}} />
          <AlbumCard album={summary(album('low-tide'))} />
          <AlbumCard album={summary(album('live-glasshouse'))} subtitle="year" />
          <ArtistCard artist={artists[1]} />
          <ArtistCard artist={artists.at(-1)!} />
          <PlaylistCard playlist={playlistSummaries[0]} onPlay={() => {}} />
        </CardGrid>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {albums.slice(0, 4).map(item => <GenreTile key={item.id} name={item.genres[0]} color={item.artwork?.color ?? '#4a4d71'} art={<Cover artwork={item.artwork} size={96} />} onClick={() => {}} />)}
        </div>
        <Rail title="Rail">
          {albums.map(item => <RailItem key={item.id}><AlbumCard album={summary(item)} onPlay={() => {}} /></RailItem>)}
        </Rail>
      </Group>

      <Group title="Track rows">
        <div className="flex flex-col">
          {states.map(({ label, track: item, nowPlaying }, index) => (
            <div key={label} className="flex items-center gap-3">
              <span className="w-24 shrink-0 text-right text-xs text-muted-foreground max-sm:hidden">{label}</span>
              <ul className="min-w-0 flex-1">
                <TrackRow track={item} index={index} variant="compact" nowPlaying={nowPlaying} onPlay={() => {}} onAction={() => {}} />
              </ul>
            </div>
          ))}
        </div>
        <SectionHeader title="Album variant with discs" />
        <TrackList label="Blue Hour" tracks={album('blue-hour').discs.flatMap(disc => disc.tracks)} discs={album('blue-hour').discs} variant="album" onPlay={() => {}} onAction={() => {}} />
        <SectionHeader title="Playlist variant" />
        <TrackList label="Playlist" tracks={[track('amber'), track('static-bloom'), track('low-tide-song')]} addedAt={['2026-11-18T10:00:00Z', '2026-11-10T10:00:00Z', '2026-10-02T10:00:00Z']} variant="playlist" onPlay={() => {}} onAction={() => {}} />
      </Group>

      <Group title="Player">
        <div className="overflow-hidden rounded-xl border">
          <PlayerBar player={player} liked onToggleLike={() => {}} queueOpen={false} onToggleQueue={() => {}} lyricsOpen={false} onToggleLyrics={() => {}} onOpenNowPlaying={() => {}} />
        </div>
        <div className="max-w-sm"><MiniPlayer player={player} onOpenNowPlaying={() => {}} /></div>
        <PlayingElsewhere device={player.state.devices[2]} onPlayHere={() => {}} />
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="rounded-xl border bg-card p-2"><DeviceList player={player} /></div>
          <ScrollArea className="h-[28rem] rounded-xl border bg-card p-3"><QueueContent player={player} /></ScrollArea>
          <div className="h-[28rem] overflow-hidden rounded-xl border bg-card px-4"><LyricsPane lyrics={lyricsFor(track('night-swimming').id)} onSeek={player.controls.seek} /></div>
        </div>
      </Group>
    </>
  )
}

function AddingMusic() {
  const [state, setState] = useState<UploadState>('Drop zone')
  const snapshot = uploadSnapshot(state)
  const unavailable = state.startsWith('No folder') ? 'no_managed_root' as const : null
  const said = (title: string) => () => toast({ title })
  return (
    <Group title="Add music">
      <div className="flex max-w-4xl flex-col gap-6">
        <Chooser label="Upload panel state" options={uploadStates} value={state} onChange={setState} />
        <UploadPanel
          options={{ ...importOptions, unavailable }}
          isAdmin={state !== 'No folder, member'}
          upload={snapshot}
          reading={state === 'Reading'}
          onDrop={said('Dropped')}
          onPick={said('Picked')}
          onStart={() => setState('Uploading')}
          onPause={() => setState('Paused')}
          onCancel={() => setState('Drop zone')}
          onClear={() => setState('Drop zone')}
        />
        <ImportsList imports={imports} ownerOf={item => (item.kind === 'upload' ? 'you' : null)} onCancel={said('Import cancelled')} />
        <ImportsList imports={undefined} ownerOf={() => null} onCancel={() => {}} />
        <ImportsList imports={[]} ownerOf={() => null} onCancel={() => {}} />
        <ImportDetail item={imports[1]} albums={undefined} isAdmin onCancel={said('Import cancelled')} />
        <ImportDetail item={{ ...imports[2], timedOut: true }} owner="you" albums={importAlbums} isAdmin>
          <NotTaken files={uploadFiles} />
        </ImportDetail>
        <ImportDetail item={imports[5]} albums={undefined} isAdmin={false} />
      </div>
    </Group>
  )
}

function BeforeSignIn() {
  const [view, setView] = useState<AuthView | null>(null)
  const [path, setPath] = useState('/srv')
  const library = {
    alreadyAdded: null,
    path,
    listing: listingOf(path),
    listingError: undefined,
    onBrowse: setPath,
    onAddFolder: later,
    onMakeManaged: later,
    onContinue: () => setView('Setup: done'),
  }
  return (
    <Group title="Before sign-in">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {pickerStates.map(({ label, ...props }) => (
          <figure key={label} className="flex min-w-0 flex-col gap-1.5">
            <FolderPicker {...props} onBrowse={() => {}} />
            <figcaption className="text-xs text-muted-foreground">Folder picker: {label}</figcaption>
          </figure>
        ))}
      </div>
      {/* One at a time, and none at first: each form takes the focus when it appears. */}
      <Chooser label="Page before sign-in" options={authViews} value={view} onChange={setView} />
      {view && (
        <div className="overflow-hidden rounded-xl border [&>div]:min-h-0">
          {view === 'Sign in page' && <LoginView serverName="Squirmy" version="1.4.0" inviteRequired onSubmit={later} />}
          {view === 'Register page' && <RegisterView serverName="Squirmy" version="1.4.0" inviteCode="" inviteRequired onSubmit={later} />}
          {view === 'Setup: account' && <SetupAccountView onCreateAdmin={later} />}
          {view === 'Setup: music' && <SetupLibraryView {...library} roots={roots} alreadyAdded={roots[0].id} />}
          {view === 'Setup: first folder' && <SetupLibraryView {...library} roots={[]} />}
          {view === 'Setup: done' && <SetupDoneView folderPaths={roots.map(root => root.path)} onFinish={() => setView(null)} />}
          {view === 'Unreachable' && <UnreachableView message="The server did not answer." onRetry={() => toast({ title: 'Trying again' })} />}
          {view === 'Splash' && <SplashView />}
        </div>
      )}
    </Group>
  )
}
