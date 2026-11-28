import { type QueueOp, type QueueSeed, SessionQueueOps } from '@squirmy/contracts'
import { describe, expect, it } from 'vitest'
import { applyQueueOps, diffQueue, QUEUE_OPS_LIMITS, queueLengths } from './queue-ops.js'
import { type AnySessionCommand, createInitialSession, HISTORY_LIMIT, reduceSession, type Session, splitSession } from './reducer.js'

const track = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const seed = (n: number, extra: Partial<QueueSeed> = {}): QueueSeed => ({ trackId: track(n), albumId: track(999), durationMs: 200_000, ...extra })
const seeds = (count: number, from = 1) => Array.from({ length: count }, (_, i) => seed(from + i))
const LISTS = ['queue', 'history', 'autoplayQueue', 'playOrder', 'playedInCycle'] as const
const UNLIMITED = { inline: Infinity, permute: Infinity, bytes: Infinity }

let serial = 0
function run(session: Session, command: AnySessionCommand, now = 1000): Session {
  serial += 1
  return reduceSession(session, { command, now, commandId: `c${serial}`, deviceId: 'phone' })
}

/** Diffs, sends the operations through JSON as the socket would, and applies them. */
function roundTrip(previous: Session, next: Session, limits = UNLIMITED) {
  const before = splitSession(previous).queue
  const after = splitSession(next).queue
  const ops = diffQueue(before, after, limits)
  if (!ops) return { ops, applied: null, before, after }
  const message = JSON.parse(JSON.stringify({ version: 2, queueVersion: 2, baseQueueVersion: 1, scope: { type: 'shared' }, lengths: queueLengths(after), ops }))
  const parsed = SessionQueueOps.parse(message)
  return { ops, applied: applyQueueOps(before, parsed.ops, parsed.lengths), before, after }
}

const bytes = (ops: QueueOp[] | null) => JSON.stringify(ops).length

describe('diffQueue and applyQueueOps', () => {
  /** Mulberry32: a small deterministic PRNG. */
  function prng(seedValue: number) {
    let state = seedValue
    return () => {
      state = (state + 0x6d2b79f5) | 0
      let t = Math.imul(state ^ (state >>> 15), 1 | state)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  function randomCommand(random: () => number, session: Session): AnySessionCommand {
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!
    const int = (max: number) => Math.floor(random() * max)
    const someSeeds = (most: number) => Array.from({ length: 1 + int(most) }, () => seed(1 + int(40), {
      state: random() < 0.2 ? 'preparing' : 'ready',
      durationMs: random() < 0.1 ? 0 : 1000 + int(300_000),
    }))
    const entryIds = [...session.queue, ...session.autoplayQueue, ...(session.current ? [session.current] : [])].map(entry => entry.id)
    const anEntry = () => (entryIds.length && random() < 0.95 ? pick(entryIds) : 'missing')
    const current = () => session.current?.id ?? 'missing'
    const commands: [weight: number, make: () => AnySessionCommand][] = [
      [1, () => ({ type: 'play' })],
      [1, () => ({ type: 'pause' })],
      [3, () => ({ type: 'next' })],
      [2, () => ({ type: 'previous', ...(random() < 0.5 ? { restart: false } : {}) })],
      [1, () => ({ type: 'setShuffle', value: random() < 0.5, seed: int(1e9) })],
      [1, () => ({ type: 'setRepeat', value: pick(['off', 'all', 'one'] as const) })],
      [1, () => ({ type: 'setAutoplay', value: random() < 0.5 })],
      [1, () => ({ type: 'playTracks', tracks: someSeeds(80), seed: int(1e9), shuffle: random() < 0.3, ...(random() < 0.5 ? { startIndex: int(60) } : {}) })],
      [3, () => ({ type: 'enqueue', tracks: someSeeds(6), placement: pick(['next', 'last'] as const) })],
      [2, () => ({ type: 'playQueueEntry', entryId: anEntry() })],
      [2, () => ({ type: 'removeFromQueue', entryId: anEntry() })],
      [2, () => ({ type: 'moveInQueue', entryId: anEntry(), toIndex: int(80) })],
      [0.3, () => ({ type: 'clearQueue' })],
      [0.3, () => ({ type: 'clearHistory' })],
      [6, () => ({ type: 'trackEnded', entryId: current() })],
      [2, () => ({ type: 'setEntryState', trackId: track(1 + int(40)), state: pick(['ready', 'preparing', 'failed'] as const) })],
      [1, () => ({ type: 'setAutoplayQueue', tracks: random() < 0.2 ? [] : someSeeds(20) })],
      [1, () => ({ type: 'updateTracks', tracks: [{ trackId: track(1 + int(40)), id: track(1 + int(40)), durationMs: int(400_000) }] })],
    ]
    const total = commands.reduce((sum, [weight]) => sum + weight, 0)
    let roll = random() * total
    for (const [weight, make] of commands) {
      roll -= weight
      if (roll < 0) return make()
    }
    return commands[0]![1]()
  }

  it('turns the previous queue into the next under random commands, leaving untouched lists as they were', () => {
    for (let round = 0; round < 120; round += 1) {
      const random = prng(round + 1)
      let session = run(createInitialSession(), { type: 'playTracks', tracks: seeds(30), seed: 1 }, 0)
      let now = 0
      for (let step = 0; step < 250; step += 1) {
        const command = randomCommand(random, session)
        now += Math.floor(random() * 20_000)
        const next = reduceSession(session, { command, now, commandId: `r${round}s${step}`, deviceId: 'phone' })
        const { ops, applied, before, after } = roundTrip(session, next)
        const where = `round ${round}, step ${step}, ${command.type}`
        expect(ops, where).not.toBeNull()
        expect(applied, where).toEqual(after)
        for (const list of LISTS) if (before[list] === after[list]) expect(applied![list], `${where}: ${list}`).toBe(before[list])
        // Within the limits, the operations either fit or the change goes whole.
        const limited = diffQueue(before, after)
        if (limited) expect(applyQueueOps(before, limited, queueLengths(after)), where).toEqual(after)
        session = next
      }
    }
  })

  it('sends a track end on a full queue in a few hundred bytes', () => {
    let session = run(createInitialSession(), { type: 'playTracks', tracks: seeds(5000), seed: 1 }, 0)
    session = run(session, { type: 'enqueue', tracks: seeds(4999, 5001), placement: 'last' })
    // Fill the history and the cycle to their caps, so they drop from the front as they grow.
    for (let i = 0; i < HISTORY_LIMIT + 5; i += 1) session = run(session, { type: 'trackEnded', entryId: session.current!.id })
    const next = run(session, { type: 'trackEnded', entryId: session.current!.id })
    const { ops, applied, after } = roundTrip(session, next, QUEUE_OPS_LIMITS)
    expect(applied).toEqual(after)
    expect(bytes(ops)).toBeLessThan(600)
    expect(JSON.stringify(splitSession(next).queue).length).toBeGreaterThan(1_000_000)
  })

  it('writes an entry another list already holds as a ref', () => {
    const session = run(createInitialSession(), { type: 'playTracks', tracks: seeds(10), seed: 1 }, 0)
    const id = session.queue[4]!.id
    const next = run(session, { type: 'playQueueEntry', entryId: session.queue[5]!.id })
    const { ops, applied, after } = roundTrip(session, next)
    expect(applied).toEqual(after)
    // The skipped entries move behind the current one by id; only the entry that was playing is written out.
    expect(JSON.stringify(ops)).toContain(`{"ref":"${id}"}`)
    expect(ops!.flatMap(op => (op.op === 'splice' ? op.insert : [])).filter(item => typeof item === 'object' && !('ref' in item))).toHaveLength(1)
  })

  it('moves one entry with two small splices, however far', () => {
    const session = run(createInitialSession(), { type: 'playTracks', tracks: seeds(3000), seed: 1 }, 0)
    const next = run(session, { type: 'moveInQueue', entryId: session.queue[0]!.id, toIndex: 2900 })
    const { ops, applied, after } = roundTrip(session, next, QUEUE_OPS_LIMITS)
    expect(applied).toEqual(after)
    expect(ops).toHaveLength(2)
    expect(bytes(ops)).toBeLessThan(200)
  })

  it('patches the entries of a track whose state changed', () => {
    let session = run(createInitialSession(), { type: 'playTracks', tracks: [seed(1), seed(2, { state: 'preparing' }), seed(3)], seed: 1 }, 0)
    session = run(session, { type: 'enqueue', tracks: [seed(2, { state: 'preparing' })], placement: 'last' })
    const next = run(session, { type: 'setEntryState', trackId: track(2), state: 'ready' })
    const { ops, applied, after } = roundTrip(session, next)
    expect(applied).toEqual(after)
    expect(ops!.map(op => op.op)).toEqual(['patch', 'patch'])
  })

  it('removes scattered ids by id', () => {
    const before = { ...splitSession(createInitialSession()).queue, playOrder: ['a', 'b', 'c', 'd', 'e', 'f'] }
    const after = { ...before, playOrder: ['a', 'c', 'e', 'f'] }
    const ops = diffQueue(before, after)
    expect(ops).toEqual([{ op: 'removeIds', list: 'playOrder', ids: ['b', 'd'] }])
    expect(applyQueueOps(before, ops!, queueLengths(after))).toEqual(after)
  })

  it('reorders with a permutation, and goes whole past the limits', () => {
    const small = run(createInitialSession(), { type: 'playTracks', tracks: seeds(40), seed: 1 }, 0)
    const shuffledSmall = run(small, { type: 'setShuffle', value: true, seed: 7 })
    const { ops, applied, after } = roundTrip(small, shuffledSmall, QUEUE_OPS_LIMITS)
    expect(applied).toEqual(after)
    expect(ops!.some(op => op.op === 'permute')).toBe(true)

    const large = run(createInitialSession(), { type: 'playTracks', tracks: seeds(5000), seed: 1 }, 0)
    expect(diffQueue(splitSession(large).queue, splitSession(run(large, { type: 'setShuffle', value: true, seed: 7 })).queue)).toBeNull()
    // A new queue writes out every entry.
    expect(diffQueue(splitSession(large).queue, splitSession(run(large, { type: 'playTracks', tracks: seeds(300, 6000), seed: 1 })).queue)).toBeNull()
  })

  it('refuses operations that do not fit the queue held', () => {
    const session = run(createInitialSession(), { type: 'playTracks', tracks: seeds(5), seed: 1 }, 0)
    const { queue } = splitSession(session)
    const lengths = queueLengths(queue)
    expect(applyQueueOps(queue, [{ op: 'splice', list: 'queue', at: 3, remove: 5, insert: [] }])).toBeNull()
    expect(applyQueueOps(queue, [{ op: 'splice', list: 'queue', at: 0, remove: 0, insert: [{ ref: 'unknown' }] }])).toBeNull()
    expect(applyQueueOps(queue, [{ op: 'splice', list: 'playOrder', at: 0, remove: 0, insert: [queue.queue[0]!] }])).toBeNull()
    expect(applyQueueOps(queue, [{ op: 'splice', list: 'queue', at: 0, remove: 0, insert: ['an-id'] }])).toBeNull()
    expect(applyQueueOps(queue, [{ op: 'patch', list: 'queue', at: 0, entry: queue.queue[1]! }])).toBeNull()
    expect(applyQueueOps(queue, [{ op: 'permute', list: 'queue', at: 0, from: [0, 0] }])).toBeNull()
    expect(applyQueueOps(queue, [{ op: 'splice', list: 'queue', at: 0, remove: 1, insert: [] }], lengths)).toBeNull()
    expect(applyQueueOps(queue, [], lengths)).toEqual(queue)
  })
})
