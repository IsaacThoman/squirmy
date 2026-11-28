import type { Artwork, ReplayStats } from '@squirmy/contracts'
import { AudioLines, CalendarDays, Clock3, Disc3, Flame, Headphones, Music2, Play, Users } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { Cover } from '@/components/music/Cover'
import { SectionHeader } from '@/components/music/SectionHeader'
import { EmptyState } from '@/components/ui/feedback'
import { IconButton } from '@/components/ui/icon-button'
import { albumPresentation, isPlayable } from '@/lib/catalog'
import { plural } from '@/lib/format'
import { useViewer } from '@/player/on-demand-context'
import { usePlayerControls } from '@/player/player-context'
import { usePlayCollections } from '@/player/use-play-collections'

type Rank = ReplayStats['genres'][number]

function listeningTime(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes === 0) return ms > 0 ? '<1 min' : '0 min'
  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60
  return hours ? `${hours.toLocaleString()} h${remainder ? ` ${remainder} min` : ''}` : `${minutes} min`
}

const count = (value: number) => value.toLocaleString()
const panel = 'min-w-0 rounded-xl border bg-card p-4 md:p-5'
const link = 'rounded-sm decoration-1 underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring'

function dateLabel(date: string | null, tz: string) {
  return date ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: tz }).format(new Date(date)) : null
}

export function ReplayView({ stats, tz, reviewYear }: { stats: ReplayStats; tz: string; reviewYear?: number }) {
  const { totals, window, previous, streak, discoveries } = stats
  const end = dateLabel(new Date(new Date(window.end).getTime() - 1).toISOString(), tz)
  const start = dateLabel(window.start, tz)
  return (
    <div className="flex flex-col gap-5">
      <section aria-label="Listening totals" className="overflow-hidden rounded-2xl border bg-card">
        <div className="relative isolate flex flex-wrap items-end justify-between gap-5 overflow-hidden bg-[radial-gradient(ellipse_at_95%_0%,color-mix(in_oklab,var(--color-primary)_22%,transparent),transparent_68%)] px-5 py-7 sm:px-8 md:py-9">
          <AudioLines aria-hidden className="pointer-events-none absolute top-1/2 right-7 -z-10 size-52 -translate-y-1/2 text-primary/12 max-sm:right-0 max-sm:size-36" strokeWidth={0.75} />
          <div>
            <p className="text-sm font-medium text-muted-foreground">{reviewYear ? `${reviewYear} Year in Review` : start ? `${start} – ${end}` : 'All time'}</p>
            <p className="mt-2 text-4xl leading-none font-semibold tracking-tighter tabular-nums sm:text-5xl">{listeningTime(totals.msPlayed)}</p>
            <p className="mt-2 text-sm text-muted-foreground">Time listened</p>
          </div>
          {previous && <PeriodComparison currentMs={totals.msPlayed} previous={previous} />}
        </div>
        <dl className="grid grid-cols-2 border-t sm:grid-cols-4 sm:divide-x">
          {[
            { name: 'Plays', value: totals.plays, icon: Headphones },
            { name: 'Tracks', value: totals.tracks, icon: Music2 },
            { name: 'Artists', value: totals.artists, icon: Users },
            { name: 'Albums', value: totals.albums, icon: Disc3 },
          ].map(({ name, value, icon: Icon }) => <div key={name} className="px-5 py-3.5 odd:max-sm:border-r [&:nth-child(-n+2)]:max-sm:border-b">
            <dt className="flex items-center gap-1.5 text-xs text-muted-foreground"><Icon aria-hidden className="size-3.5" />{name}</dt>
            <dd className="mt-1 text-xl font-semibold tabular-nums">{count(value)}</dd>
          </div>)}
        </dl>
      </section>

      {totals.plays === 0 ? <EmptyState icon={<Headphones />} title="No plays in this period" description="Choose another period or import listening history below." /> : <>
        <div className="grid gap-5 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <section className={panel}>
            <SectionHeader title="Listening clock" />
            <ListeningClock clock={stats.clock} tz={tz} />
          </section>
          <section className={panel}>
            <SectionHeader title="Streaks" />
            <dl className="grid grid-cols-2 gap-3 xl:grid-cols-1">
              <Streak icon={<Flame />} title={reviewYear ? 'At period end' : 'Current'} days={streak.current} />
              <Streak icon={<CalendarDays />} title="Longest in period" days={streak.longest} />
            </dl>
          </section>
        </div>
        <Rankings stats={stats} />
        <section className={panel}>
          <SectionHeader title="New discoveries" />
          <p className="text-sm text-muted-foreground">{discoveries.count ? `${plural(discoveries.count, 'artist')} heard for the first time` : 'No first-time artists in this period.'}</p>
          {discoveries.artists.length > 0 && <ul className="mt-2 grid gap-x-6 sm:grid-cols-2">
            {discoveries.artists.map(artist => <li key={artist.key} className="flex items-baseline justify-between gap-2 border-b py-2 text-sm last:border-b-0">
              {artist.id ? <Link to={`/artist/${artist.id}`} className={`truncate font-medium ${link}`}>{artist.name}</Link> : <span className="truncate font-medium">{artist.name}</span>}
              <span className="shrink-0 text-xs text-muted-foreground">{dateLabel(artist.firstPlayedAt, tz)}</span>
            </li>)}
          </ul>}
        </section>
      </>}
    </div>
  )
}

function PeriodComparison({ currentMs, previous }: { currentMs: number; previous: NonNullable<ReplayStats['previous']> }) {
  const scale = Math.max(currentMs, previous.msPlayed, 1)
  return <div className="w-48 max-w-full text-sm">
    <div className="mb-2.5 space-y-1.5" aria-hidden>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-primary" style={{ width: `${currentMs / scale * 100}%` }} />
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-foreground/40" style={{ width: `${previous.msPlayed / scale * 100}%` }} />
      </div>
    </div>
    <p className="text-xs text-muted-foreground">Previous period</p>
    <p className="mt-0.5 font-medium tabular-nums">{listeningTime(previous.msPlayed)} · {plural(previous.plays, 'play')}</p>
  </div>
}

function Streak({ icon, title, days }: { icon: ReactNode; title: string; days: number }) {
  return <div className="flex items-center gap-2.5 rounded-lg bg-muted/55 p-2.5 sm:p-3">
    <div className="shrink-0 text-primary [&_svg]:size-5" aria-hidden>{icon}</div>
    <div>
      <dt className="text-xs text-muted-foreground">{title}</dt>
      <dd className="mt-0.5 font-semibold tabular-nums">{plural(days, 'day')}</dd>
    </div>
  </div>
}

const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const hours = Array.from({ length: 24 }, (_, hour) => hour)
const hourLabel = (hour: number) => `${hour % 12 || 12} ${hour < 12 ? 'AM' : 'PM'}`
const clockColumns = { gridTemplateColumns: '2.3rem repeat(24, minmax(0, 1fr))' }

function ListeningClock({ clock, tz }: { clock: ReplayStats['clock']; tz: string }) {
  const cells = new Map(clock.map(cell => [cell.weekday * 24 + cell.hour, cell.plays]))
  const max = Math.max(1, ...clock.map(cell => cell.plays))
  const opacity = (plays: number) => plays ? 0.22 + 0.78 * Math.sqrt(plays / max) : 0
  return (
    <>
      <div className="grid items-center gap-x-px gap-y-1 sm:gap-x-0.5" style={clockColumns} aria-hidden>
        <span />
        {[0, 6, 12, 18].map(hour => <span key={hour} className="col-span-6 mb-1 whitespace-nowrap text-[11px] text-muted-foreground">{hourLabel(hour)}</span>)}
        {weekdays.flatMap((day, index) => [
          <span key={day} className="text-xs text-muted-foreground">{day}</span>,
          ...hours.map(hour => {
            const plays = cells.get((index + 1) * 24 + hour) ?? 0
            return <span key={`${day}-${hour}`} title={`${day}, ${hourLabel(hour)} · ${plural(plays, 'play')}`}
              className="h-3 rounded-[2px] bg-muted sm:h-4">
              <span className="block h-full rounded-[inherit] bg-primary" style={{ opacity: opacity(plays) }} />
            </span>
          }),
        ])}
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span><Clock3 className="mr-1 inline size-3.5" aria-hidden />{tz.replaceAll('_', ' ')}</span>
        <span className="flex items-center gap-1.5" aria-hidden>
          Fewer
          {[0, 0.25, 0.5, 0.75, 1].map(level => <span key={level} className="size-2.5 rounded-[2px] bg-muted">
            <span className="block size-full rounded-[inherit] bg-primary" style={{ opacity: level }} />
          </span>)}
          More
        </span>
      </div>
      <table className="sr-only">
        <caption>Plays by day of the week and hour in {tz}</caption>
        <thead><tr><th scope="col">Day</th>{hours.map(hour => <th key={hour} scope="col">{hourLabel(hour)}</th>)}</tr></thead>
        <tbody>{weekdays.map((day, index) => <tr key={day}>
          <th scope="row">{day}</th>{hours.map(hour => <td key={hour}>{cells.get((index + 1) * 24 + hour) ?? 0}</td>)}
        </tr>)}</tbody>
      </table>
    </>
  )
}

function Rankings({ stats }: { stats: ReplayStats }) {
  const viewer = useViewer()
  const controls = usePlayerControls()
  const { playAlbum, playArtist } = usePlayCollections()
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <RankList title="Top tracks" rows={stats.tracks} render={row => {
        const { track } = row
        return <RankRow row={row} path={track ? `/track/${track.id}${track.album ? `?album=${track.album.id}` : ''}` : undefined}
          artwork={track?.album?.artwork} unavailable={!track || !isPlayable(track, viewer)}
          onPlay={track && isPlayable(track, viewer) ? () => controls.playTracks([track], 0) : undefined} />
      }} />
      <RankList title="Top artists" rows={stats.artists} render={row => {
        const tracks = stats.tracks.flatMap(({ track }) => track && row.id && track.artists.some(credit => credit.id === row.id) && isPlayable(track, viewer) ? [track] : [])
        return <RankRow row={row} path={row.id ? `/artist/${row.id}` : undefined} artwork={row.image} round
          onPlay={row.id ? () => {
            const artist = { id: row.id!, name: row.name }
            if (tracks.length) controls.playTracks(tracks, 0, { type: 'artist', id: artist.id, title: artist.name })
            else void playArtist(artist)
          } : undefined} />
      }} />
      <RankList title="Top albums" rows={stats.albums} render={row => {
        const { album } = row
        const playable = album && albumPresentation(album, viewer) === 'normal'
        return <RankRow row={row} path={row.id ? `/album/${row.id}` : undefined} artwork={album?.artwork}
          unavailable={!playable} onPlay={playable ? () => void playAlbum(album) : undefined} />
      }} />
      <RankList title="Top genres" rows={stats.genres} render={row => <div className="w-full py-2">
        <div className="flex items-baseline justify-between gap-3 text-sm"><span className="truncate font-medium">{row.name}</span><RankNumbers row={row} /></div>
        <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
          <div className="h-full rounded-full bg-primary/80" style={{ width: `${row.plays / (stats.genres[0]?.plays || 1) * 100}%` }} />
        </div>
      </div>} />
    </div>
  )
}

function RankList<T extends Rank>({ title, rows, render }: { title: string; rows: T[]; render: (row: T) => ReactNode }) {
  return <section className={panel}>
    <SectionHeader title={title} />
    {rows.length ? <ol>{rows.map(row => <li key={row.key} className="flex min-w-0 items-center border-b last:border-b-0">{render(row)}</li>)}</ol>
      : <p className="text-sm text-muted-foreground">No {title.slice(4).toLowerCase()} in this period.</p>}
  </section>
}

function RankRow({ row, path, artwork, round, unavailable, onPlay }: {
  row: Rank; path?: string; artwork?: Artwork | null; round?: boolean; unavailable?: boolean; onPlay?: () => void
}) {
  return <div className="flex min-w-0 flex-1 items-center gap-2 py-1.5 sm:gap-3">
    <Cover artwork={artwork ?? null} size={96} className="size-9 shrink-0" dimmed={unavailable} round={round} />
    <div className="min-w-0 flex-1">
      {path ? <Link to={path} className={`block truncate text-sm font-medium ${link}`}>{row.name}</Link> : <span className="block truncate text-sm font-medium">{row.name}</span>}
      {row.artist && <p className="truncate text-xs text-muted-foreground">{row.artist}</p>}
    </div>
    <RankNumbers row={row} />
    {onPlay && <IconButton label={`Play ${row.name}`} onClick={onPlay} size="sm" variant="ghost"><Play /></IconButton>}
  </div>
}

function RankNumbers({ row }: { row: Rank }) {
  return <span className="shrink-0 text-right text-xs text-muted-foreground tabular-nums">
    {plural(row.plays, 'play')}<span aria-hidden className="max-[420px]:hidden"> · </span><span className="max-[420px]:block">{listeningTime(row.msPlayed)}</span>
  </span>
}
