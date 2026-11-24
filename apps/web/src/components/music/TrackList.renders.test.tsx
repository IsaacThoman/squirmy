import type { TrackSummary } from '@squirmy/contracts'
import { act, screen } from '@testing-library/react'
import { useEffect, type ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { album } from '@/fixtures/catalog'
import { usePlayerControls, type PlayerControls } from '@/player/player-context'
import { useTrackActions } from '@/player/use-track-actions'
import { renderWithApp } from '@/test/render'
import { TrackList } from './TrackList'

/** How many times each row rendered, by track id: every render of a row renders its heart. */
const renders = new Map<string, number>()

vi.mock('./LibrarySave', async original => {
  const module = await original<typeof import('./LibrarySave')>()
  return {
    ...module,
    SaveHeart: (props: ComponentProps<typeof module.SaveHeart>) => {
      const id = props.id ?? ''
      renders.set(id, (renders.get(id) ?? 0) + 1)
      return <module.SaveHeart {...props} />
    },
  }
})

const tracks: TrackSummary[] = album('blue-hour').discs.flatMap(disc => disc.tracks)

/** A page's song list as the views draw one: the player's actions, and the rows. `expose` hands the test the player's commands. */
function Songs({ expose }: { expose: (controls: PlayerControls) => void }) {
  const controls = usePlayerControls()
  useEffect(() => expose(controls), [controls, expose])
  const actions = useTrackActions(tracks)
  return <TrackList label="Songs" tracks={tracks} variant="compact" {...actions} />
}

const rendered = () => Object.fromEntries(renders)

afterEach(() => renders.clear())

describe('song rows and the session', () => {
  it('render only when what they show of it changes', async () => {
    expect(tracks.length).toBeGreaterThan(4)
    let controls!: PlayerControls
    renderWithApp(<Songs expose={value => { controls = value }} />)
    act(() => controls.playTracks(tracks, 1))
    expect(await screen.findByRole('img', { name: 'Playing' })).toBeInTheDocument()

    renders.clear()
    act(() => {
      for (let step = 0; step <= 10; step += 1) controls.setVolume(step / 10)
    })
    expect(rendered()).toEqual({})

    act(() => controls.seek(30_000))
    // The fixture session's clock moves on every 250 ms while it plays.
    await act(() => new Promise(resolve => setTimeout(resolve, 600)))
    expect(rendered()).toEqual({})

    act(() => controls.togglePlay())
    expect(rendered()).toEqual({ [tracks[1].id]: 1 })

    renders.clear()
    act(() => controls.next())
    expect(rendered()).toEqual({ [tracks[1].id]: 1, [tracks[2].id]: 1 })
    expect(screen.getAllByRole('listitem').filter(row => row.getAttribute('aria-current') === 'true')).toHaveLength(1)
  })
})
