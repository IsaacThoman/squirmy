import { queryKeys, type AcquisitionJobStatus, type AlbumDetail } from '@squirmy/contracts'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useApi } from '@/api/services'
import { useCurrentUser } from '@/auth/session'
import { canRequestMusic } from '@/lib/catalog'
import { plural } from '@/lib/format'
import { toast } from '@/lib/toast'
import { useServerEvent } from '@/realtime/realtime-context'
import { OnDemandContext, type OnDemand } from './on-demand-context'
import { usePlayer } from './player-context'

/** A job this tab knows of: from a request made here, or from the server's events. */
type Job = { trackId: string | null; albumId: string | null; status: AcquisitionJobStatus }

const failure = (status: string | undefined) => status === 'failed' || status === 'rejected'
const ended = (status: string) => status === 'completed' || failure(status)

/**
 * Fetching on demand for the signed-in user. Jobs are learned from requests made here and
 * from `acquisition.updated`; a job's end refreshes the track and album it was for, so a
 * fetched track lights up and a failed one goes gray. A failed track of the session is
 * told by name: the session skips a failed current entry and drops it in the same change,
 * so its state alone never says so. Failures of an album asked for here are told once.
 */
export function OnDemandProvider({ children }: { children: ReactNode }) {
  const api = useApi()
  const queryClient = useQueryClient()
  const user = useCurrentUser()
  const { current, queue, autoplayQueue } = usePlayer().state
  const [jobs, setJobs] = useState<ReadonlyMap<string, Job>>(new Map())
  const [albums, setAlbums] = useState<ReadonlyMap<string, { title: string; jobIds: string[] }>>(new Map())

  const remember = (entries: [string, Job][]) => setJobs(known => new Map([...known, ...entries]))

  // Tracks of the session by id, kept after they leave it, so a failure can be told by name.
  const titles = useRef(new Map<string, string>())
  useEffect(() => {
    for (const item of [current, ...queue, ...autoplayQueue]) if (item) titles.current.set(item.track.id, item.track.title)
  }, [current, queue, autoplayQueue])

  useServerEvent('acquisition.updated', event => {
    const known = jobs.get(event.jobId)
    if (!known && !event.trackId) return
    const job: Job = { trackId: known?.trackId ?? event.trackId, albumId: known?.albumId ?? null, status: event.status as AcquisitionJobStatus }
    remember([[event.jobId, job]])
    if (!ended(job.status)) return
    if (job.trackId) void queryClient.invalidateQueries({ queryKey: queryKeys.track(job.trackId) })
    if (job.albumId) void queryClient.invalidateQueries({ queryKey: queryKeys.album(job.albumId) })
    const title = job.trackId && titles.current.get(job.trackId)
    // The same words as the session's own notice, so one failure is told once.
    if (failure(job.status) && title) toast({ title: `Couldn’t get “${title}”`, description: 'It was skipped.' })
  })

  // An album asked for here says once, when all its jobs ended, what it could not get.
  const told = useRef(new Set<string>())
  useEffect(() => {
    for (const [albumId, album] of albums) {
      const statuses = album.jobIds.map(id => jobs.get(id)?.status)
      if (told.current.has(albumId) || !statuses.every(status => status && ended(status))) continue
      told.current.add(albumId)
      const failed = statuses.filter(failure).length
      if (failed) toast({ title: `Couldn’t get ${failed === statuses.length ? 'this album' : plural(failed, 'song')}`, description: album.title })
    }
  }, [jobs, albums])

  const request = useMutation({
    mutationFn: (album: AlbumDetail) => api.acquisition.acquireAlbum(album.id),
    onSuccess: ({ items }, album) => {
      remember(items.map(job => [job.id, { trackId: job.trackId, albumId: album.id, status: job.status }]))
      told.current.delete(album.id)
      setAlbums(current => new Map(current).set(album.id, { title: album.title, jobIds: items.map(job => job.id) }))
    },
  })
  const getAlbum = request.mutateAsync

  // Upcoming entries wait as `preparing` too, but only the current one, and those with a job, are being fetched.
  const waiting = current?.entry.state === 'preparing' ? current.entry.trackId : null

  const value = useMemo<OnDemand>(() => {
    const running = [...jobs.values()].filter(job => !ended(job.status))
    return {
      canRequest: canRequestMusic(user),
      isPreparing: track => track.availability !== 'server' && (
        track.id === waiting
        || running.some(job => job.trackId === track.id || (job.trackId === null && job.albumId !== null && job.albumId === track.album?.id))
      ),
      getAlbum,
      albumFetch: albumId => {
        const album = albums.get(albumId)
        if (!album) return null
        const statuses = album.jobIds.map(id => jobs.get(id)?.status)
        return {
          jobs: statuses.length,
          running: statuses.filter(status => status && !ended(status)).length,
          failed: statuses.filter(failure).length,
        }
      },
    }
  }, [user, jobs, albums, waiting, getAlbum])

  return <OnDemandContext value={value}>{children}</OnDemandContext>
}
