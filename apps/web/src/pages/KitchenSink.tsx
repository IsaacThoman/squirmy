import type { TrackSummary } from '@squirmy/contracts'
import { Bell, Heart, Inbox, MoreHorizontal, Plus, Settings, Shuffle, Trash2 } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Page } from '@/components/layout/Page'
import { AlbumCard, ArtistCard, CardGrid, GenreTile, PlaylistCard } from '@/components/music/Cards'
import { LikedCover, PlaylistCover } from '@/components/music/CollectionArt'
import { Cover } from '@/components/music/Cover'
import { Equalizer } from '@/components/music/Equalizer'
import { Rail, RailItem } from '@/components/music/Rail'
import { PageTitle, SectionHeader } from '@/components/music/SectionHeader'
import { TrackList, TrackRow, type NowPlaying } from '@/components/music/TrackList'
import { DeviceList, PlayingElsewhere } from '@/components/player/Devices'
import { LyricsPane } from '@/components/player/Lyrics'
import { MiniPlayer, PlayerBar } from '@/components/player/PlayerBar'
import { QueueContent } from '@/components/player/Queue'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogTrigger } from '@/components/ui/dialog'
import { Badge, EmptyState, ExplicitBadge, Skeleton, Spinner } from '@/components/ui/feedback'
import { IconButton } from '@/components/ui/icon-button'
import { Field, Input } from '@/components/ui/input'
import { ContextMenu, DropdownMenu, type MenuEntry } from '@/components/ui/menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ScrollArea } from '@/components/ui/scroll-area'
import { SearchField } from '@/components/ui/search-field'
import { Select } from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip } from '@/components/ui/tooltip'
import { album, albums, artists, lyricsFor, playlistSummaries, summary, track } from '@/fixtures/catalog'
import { FixtureProviders } from '@/fixtures/FixtureProviders'
import { toast } from '@/lib/toast'
import { usePlayer } from '@/player/player-context'

const swatches = ['background', 'surface', 'sheet', 'foreground', 'muted', 'quiet', 'accent', 'on-accent', 'stroke', 'overlay', 'selection', 'floating', 'danger']

const menu: MenuEntry[] = [
  { kind: 'label', label: 'Night Swimming' },
  { label: 'Play next', icon: <Shuffle />, onSelect: () => toast({ title: 'Playing next' }) },
  { label: 'Save to Liked Songs', icon: <Heart />, onSelect: () => toast({ title: 'Saved' }) },
  { kind: 'submenu', label: 'Add to playlist', icon: <Plus />, items: playlistSummaries.map(playlist => ({ label: playlist.name, onSelect: () => toast({ title: `Added to ${playlist.name}` }) })) },
  { kind: 'separator' },
  { label: 'Disabled item', onSelect: () => {}, disabled: true },
  { label: 'Delete', icon: <Trash2 />, danger: true, onSelect: () => toast({ title: 'Deleted' }) },
]

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4 border-t border-stroke pt-8">
      <h2 className="text-xs font-bold uppercase tracking-[0.14em] text-quiet">{title}</h2>
      {children}
    </section>
  )
}

function Row({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-3">{children}</div>
}

/** Every primitive and component state on one page, for design review, on the fixture catalog and session. */
export function KitchenSinkPage() {
  return <FixtureProviders><KitchenSink /></FixtureProviders>
}

function KitchenSink() {
  const player = usePlayer()
  const [slider, setSlider] = useState(40)
  const [query, setQuery] = useState('Blue hour')
  const [select, setSelect] = useState<'recent' | 'title' | 'artist'>('recent')
  const [checked, setChecked] = useState(true)
  const [pressed, setPressed] = useState(true)
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
    <Page className="flex flex-col gap-10">
      <div>
        <PageTitle>Kitchen sink</PageTitle>
        <p className="mt-2 text-muted">Every primitive and component state. Toggle your system appearance to check both palettes.</p>
      </div>

      <Section title="Palette">
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-5 lg:grid-cols-7">
          {swatches.map(name => (
            <div key={name} className="flex flex-col gap-1.5">
              <div className="h-14 rounded-xl ring-1 ring-stroke" style={{ background: `var(--${name === 'on-accent' ? 'on-accent' : name})` }} />
              <span className="font-mono text-xs text-muted">{name}</span>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Type">
        <PageTitle>Page title</PageTitle>
        <SectionHeader title="Section header" href="/" className="mb-0" />
        <p className="max-w-xl text-[15px] leading-relaxed text-muted">Body text in the muted color. Soft-focus synths and close-mic vocals trace the last light of the day.</p>
        <p className="text-[13px] text-quiet">Quiet caption · 7 songs, 34 min</p>
      </Section>

      <Section title="Buttons">
        <Row>
          <Button variant="primary">Primary</Button>
          <Button>Secondary</Button>
          <Button variant="outline">Outline</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger">Danger</Button>
          <Button variant="link">Link</Button>
          <Button variant="primary" disabled>Disabled</Button>
        </Row>
        <Row>
          <Button size="sm" variant="primary"><Plus />Small</Button>
          <Button size="md" variant="primary"><Plus />Medium</Button>
          <Button size="lg" variant="primary"><Plus />Large</Button>
        </Row>
        <Row>
          <IconButton label="Ghost"><Settings /></IconButton>
          <IconButton label="Solid" variant="solid"><Bell /></IconButton>
          <IconButton label="Toggle" pressed={pressed} onClick={() => setPressed(!pressed)}><Shuffle /></IconButton>
          <IconButton label="Contrast" variant="contrast"><Heart /></IconButton>
          <IconButton label="Accent" variant="accent" size="xl"><Heart fill="currentColor" /></IconButton>
          <IconButton label="Disabled" disabled><Trash2 /></IconButton>
          <div className="rounded-xl bg-[#344763] p-3"><IconButton label="Glass" variant="glass"><MoreHorizontal /></IconButton></div>
        </Row>
      </Section>

      <Section title="Inputs">
        <div className="grid max-w-3xl gap-5 md:grid-cols-2">
          <Field label="Text input" htmlFor="ks-input"><Input id="ks-input" placeholder="Placeholder" /></Field>
          <Field label="With an error" htmlFor="ks-error" error="That username is taken."><Input id="ks-error" defaultValue="alex" aria-invalid /></Field>
          <SearchField value={query} onValueChange={setQuery} placeholder="Songs, albums, artists" />
          <SearchField value={query} onValueChange={setQuery} size="lg" />
        </div>
        <Row>
          <Select label="Sort" prefix="Sort:" value={select} onValueChange={setSelect} options={[{ value: 'recent', label: 'Recently added' }, { value: 'title', label: 'Title' }, { value: 'artist', label: 'Artist' }]} />
          <Switch aria-label="Example switch" checked={checked} onCheckedChange={setChecked} />
          <Switch aria-label="Disabled switch" disabled />
          <div className="w-64"><Slider label="Example slider" value={slider} max={100} onValueChange={setSlider} valueText={`${slider}%`} /></div>
          <div className="w-40"><Slider label="Disabled slider" value={60} max={100} onValueChange={() => {}} disabled /></div>
        </Row>
      </Section>

      <Section title="Feedback">
        <Row>
          <Badge>Neutral</Badge>
          <Badge tone="accent">Accent</Badge>
          <Badge tone="outline">Outline</Badge>
          <Badge tone="danger">Danger</Badge>
          <ExplicitBadge />
          <Spinner />
          <Equalizer playing />
          <Equalizer playing={false} />
          <Button onClick={() => toast({ title: 'Added to queue', description: 'Night Swimming', action: { label: 'Undo', onClick: () => {} } })}>Show toast</Button>
        </Row>
        <div className="flex max-w-md items-center gap-3">
          <Skeleton className="size-12" />
          <div className="flex flex-1 flex-col gap-2"><Skeleton className="h-4 w-2/3" /><Skeleton className="h-3 w-1/3" /></div>
        </div>
        <EmptyState icon={<Inbox />} title="Empty state" description="A sentence about why it is empty and what to do." action={<Button variant="primary">Do something</Button>} className="max-w-md rounded-2xl bg-sheet py-10" />
      </Section>

      <Section title="Overlays">
        <Row>
          <DropdownMenu entries={menu} align="start" trigger={<Button><MoreHorizontal />Dropdown menu</Button>} />
          <ContextMenu entries={menu}>
            <div className="flex h-10 items-center rounded-full border border-dashed border-stroke px-4 text-sm text-muted">Right-click here</div>
          </ContextMenu>
          <Tooltip label="A tooltip"><Button variant="outline">Hover for tooltip</Button></Tooltip>
          <Dialog>
            <DialogTrigger asChild><Button variant="outline">Open dialog</Button></DialogTrigger>
            <DialogContent title="A dialog" description="Dialogs trap focus and close on Escape.">
              <Field label="Name" htmlFor="ks-dialog"><Input id="ks-dialog" /></Field>
              <DialogFooter><DialogClose asChild><Button variant="ghost">Cancel</Button></DialogClose><DialogClose asChild><Button variant="primary">Save</Button></DialogClose></DialogFooter>
            </DialogContent>
          </Dialog>
          <Popover>
            <PopoverTrigger asChild><Button variant="outline">Devices popover</Button></PopoverTrigger>
            <PopoverContent align="start"><DeviceList player={player} /></PopoverContent>
          </Popover>
        </Row>
        <Tabs defaultValue="songs">
          <TabsList><TabsTrigger value="songs">Songs</TabsTrigger><TabsTrigger value="albums">Albums</TabsTrigger><TabsTrigger value="artists">Artists</TabsTrigger></TabsList>
          <TabsContent value="songs" className="pt-3 text-sm text-muted">Songs tab</TabsContent>
          <TabsContent value="albums" className="pt-3 text-sm text-muted">Albums tab</TabsContent>
          <TabsContent value="artists" className="pt-3 text-sm text-muted">Artists tab</TabsContent>
        </Tabs>
        <ScrollArea className="h-36 max-w-sm rounded-2xl bg-sheet p-3 ring-1 ring-stroke">
          {albums.map(item => <p key={item.id} className="py-1 text-sm">{item.title} · <span className="text-muted">{item.artistCredit}</span></p>)}
        </ScrollArea>
      </Section>

      <Section title="Artwork">
        <Row>
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
            <figure key={label as string} className="flex w-28 flex-col gap-1.5">{node}<figcaption className="text-xs text-muted">{label}</figcaption></figure>
          ))}
        </Row>
      </Section>

      <Section title="Cards">
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
          {albums.slice(0, 4).map(item => <GenreTile key={item.id} name={item.genres[0]} color={item.artwork?.color ?? '#4a4d71'} art={<Cover artwork={item.artwork} size={96} className="rounded-lg" />} onClick={() => {}} />)}
        </div>
        <Rail title="Rail">
          {albums.map(item => <RailItem key={item.id}><AlbumCard album={summary(item)} onPlay={() => {}} /></RailItem>)}
        </Rail>
      </Section>

      <Section title="Track rows">
        <div className="-mx-2 flex flex-col">
          {states.map(({ label, track: item, nowPlaying }, index) => (
            <div key={label} className="flex items-center gap-3">
              <span className="w-28 shrink-0 text-right text-xs font-semibold text-quiet">{label}</span>
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
      </Section>

      <Section title="Player">
        <div className="overflow-hidden rounded-2xl ring-1 ring-stroke">
          <PlayerBar player={player} liked onToggleLike={() => {}} queueOpen={false} onToggleQueue={() => {}} lyricsOpen={false} onToggleLyrics={() => {}} onOpenNowPlaying={() => {}} />
        </div>
        <div className="max-w-sm"><MiniPlayer player={player} onOpenNowPlaying={() => {}} /></div>
        <PlayingElsewhere device={player.state.devices[2]} onPlayHere={() => {}} className="rounded-full" />
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="rounded-3xl bg-sheet p-2 ring-1 ring-stroke"><DeviceList player={player} /></div>
          <ScrollArea className="h-[28rem] rounded-3xl bg-sheet p-3 ring-1 ring-stroke"><QueueContent player={player} /></ScrollArea>
          <div className="h-[28rem] overflow-hidden rounded-3xl bg-sheet px-4 ring-1 ring-stroke"><LyricsPane lyrics={lyricsFor(track('night-swimming').id)} onSeek={player.controls.seek} /></div>
        </div>
      </Section>
    </Page>
  )
}
