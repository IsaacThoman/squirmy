import { type AnySessionCommand, createInitialSession, reduceSession, type Session } from '@squirmy/client-core'
import { type QueueSeed, type SessionCommand, UNDO_KEEP_MS, UNDO_LIMIT } from '@squirmy/contracts'
import { describe, expect, it } from 'vitest'
import { applyUndo, fresh, pushUndo, undoStepFor, type UndoStep } from './undo.js'

const track = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const seeds = (...ns: number[]): QueueSeed[] => ns.map(n => ({ trackId: track(n), albumId: null, durationMs: 200_000 }))
const numbers = (session: Session) => session.queue.map(entry => Number(entry.trackId.slice(-12)))

let serial = 0
const run = (session: Session, command: AnySessionCommand) => reduceSession(session, { command, now: 1000, commandId: `c${++serial}`, deviceId: 'phone' })

/** Runs an undoable command and returns the session after it with the step that undoes it. */
function edit(session: Session, command: SessionCommand): { after: Session; step: UndoStep } {
  const commandId = `e${++serial}`
  const after = reduceSession(session, { command, now: 1000, commandId, deviceId: 'phone' })
  const step = undoStepFor(command, commandId, session, after, 1000)
  if (!step) throw new Error(`no step for ${command.type}`)
  return { after, step }
}

function undone(session: Session, step: UndoStep): Session {
  const result = applyUndo(session, step, 2000, `u${++serial}`)
  if (typeof result === 'string') throw new Error(result)
  return result
}

const playing = (...ns: number[]) => run(createInitialSession(), { type: 'playTracks', tracks: seeds(...ns), seed: 1 })

describe('undo', () => {
  it('round-trips every undoable command', () => {
    const before = playing(1, 2, 3, 4, 5)
    for (const command of [
      { type: 'removeFromQueue', entryId: before.queue[2]!.id },
      { type: 'removeFromQueue', entryId: before.queue[0]!.id },
      { type: 'enqueue', tracks: seeds(8, 9), placement: 'next' },
      { type: 'enqueue', tracks: seeds(8), placement: 'last' },
      { type: 'moveInQueue', entryId: before.queue[0]!.id, toIndex: 3 },
      { type: 'moveInQueue', entryId: before.queue[3]!.id, toIndex: 0 },
      { type: 'clearQueue' },
    ] satisfies SessionCommand[]) {
      const { after, step } = edit(before, command)
      expect(undone(after, step).queue, command.type).toEqual(before.queue)
    }
  })

  it('puts a removed entry back after its old neighbour, wherever that is now', () => {
    const before = playing(1, 2, 3, 4, 5)
    const { after, step } = edit(before, { type: 'removeFromQueue', entryId: before.queue[2]!.id })
    // Another device moves the neighbour to the end and adds a song in front.
    let elsewhere = run(after, { type: 'moveInQueue', entryId: before.queue[1]!.id, toIndex: 9 })
    elsewhere = run(elsewhere, { type: 'enqueue', tracks: seeds(7), placement: 'next' })
    expect(numbers(undone(elsewhere, step))).toEqual([7, 2, 5, 3, 4])
    // Its neighbour is playing now: back at the front.
    expect(numbers(undone(run(run(after, { type: 'next' }), { type: 'next' }), step))).toEqual([4, 5])
  })

  it('moves an entry back after its old neighbour', () => {
    const before = playing(1, 2, 3, 4, 5)
    const { after, step } = edit(before, { type: 'moveInQueue', entryId: before.queue[0]!.id, toIndex: 3 })
    const elsewhere = run(after, { type: 'removeFromQueue', entryId: before.queue[2]!.id })
    expect(numbers(undone(elsewhere, step))).toEqual([2, 3, 5])
  })

  it('removes only the added entries still queued, and keeps what was queued since a clear', () => {
    const before = playing(1, 2, 3)
    const added = edit(before, { type: 'enqueue', tracks: seeds(8, 9), placement: 'last' })
    expect(numbers(undone(run(added.after, { type: 'removeFromQueue', entryId: added.after.queue.at(-1)!.id }), added.step))).toEqual([2, 3])

    const cleared = edit(before, { type: 'clearQueue' })
    expect(numbers(undone(run(cleared.after, { type: 'enqueue', tracks: seeds(7), placement: 'last' }), cleared.step))).toEqual([2, 3, 7])
  })

  it('puts the shuffle order back with the entries', () => {
    const before = run(playing(1, 2, 3, 4, 5, 6), { type: 'setShuffle', value: true, seed: 3 })
    const removed = edit(before, { type: 'removeFromQueue', entryId: before.queue[1]!.id })
    expect(undone(removed.after, removed.step).playOrder).toEqual(before.playOrder)
    const cleared = edit(before, { type: 'clearQueue' })
    const back = undone(cleared.after, cleared.step)
    expect(back.playOrder).toEqual(before.playOrder)
    // Shuffle off afterwards restores the collection order of what came back.
    expect(numbers(run(back, { type: 'setShuffle', value: false, seed: 0 })).length).toBe(before.queue.length)
  })

  it('has nothing to undo once the edit no longer applies', () => {
    const before = playing(1, 2, 3)
    const added = edit(before, { type: 'enqueue', tracks: seeds(8), placement: 'next' })
    expect(applyUndo(run(added.after, { type: 'next' }), added.step, 2000, 'u')).toBe('nothing_to_undo')
    const removed = edit(before, { type: 'removeFromQueue', entryId: before.queue[0]!.id })
    expect(applyUndo(undone(removed.after, removed.step), removed.step, 2000, 'u')).toBe('nothing_to_undo')
  })

  it('makes no step for commands it cannot undo, or that changed nothing', () => {
    const before = playing(1, 2, 3)
    expect(undoStepFor({ type: 'next' }, 'x', before, run(before, { type: 'next' }), 0)).toBeNull()
    expect(undoStepFor({ type: 'removeFromQueue', entryId: 'missing' }, 'x', before, before, 0)).toBeNull()
    const empty = run(before, { type: 'clearQueue' })
    expect(undoStepFor({ type: 'clearQueue' }, 'x', empty, empty, 0)).toBeNull()
  })

  it('keeps the last steps for a while', () => {
    const step = (n: number, at = n): UndoStep => ({ type: 'enqueue', commandId: `s${n}`, at, ids: [] })
    let stack: UndoStep[] = []
    for (let n = 0; n < UNDO_LIMIT + 5; n += 1) stack = pushUndo(stack, step(n))
    expect(stack.map(item => item.commandId)).toEqual(Array.from({ length: UNDO_LIMIT }, (_, i) => `s${i + 5}`))
    expect(fresh(stack, 5 + UNDO_KEEP_MS).map(item => item.commandId)).toEqual(stack.slice(1).map(item => item.commandId))
  })
})
