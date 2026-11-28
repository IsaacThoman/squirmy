import { SmartPlaylistRules } from '@squirmy/contracts'
import { describe, expect, it } from 'vitest'
import { emptyDraft, fieldOptions, newCondition, newGroup, toDraft, toRules, withField, type Draft } from './smart-rules'

const draftWith = (rules: Draft['rules'], extra: Partial<Draft> = {}): Draft => ({ ...emptyDraft(), rules, ...extra })

describe('smart playlist rules', () => {
  it('turns what was typed into the contract’s rules, in its units', () => {
    const rules = toRules(draftWith([
      { ...newCondition('genre'), value: '  Jazz ' },
      { ...newCondition('durationMs'), op: 'between', value: '3', to: '4.5' },
      { ...newCondition('addedAt'), op: 'inLast', value: '2', unit: 'weeks' },
      { ...newGroup(), conditions: [{ ...newCondition('decade'), value: '1970' }, { ...newCondition('liked'), value: 'false' }] },
    ], { limit: '25', sort: 'mostPlayed', source: 'server', match: 'any' }))
    expect(rules).toEqual({
      rules: {
        source: 'server', match: 'any', sort: 'mostPlayed', limit: 25,
        conditions: [
          { field: 'genre', op: 'contains', value: 'Jazz' },
          { field: 'durationMs', op: 'between', value: 180_000, to: 270_000 },
          { field: 'addedAt', op: 'inLast', value: 2, unit: 'weeks' },
          { match: 'any', conditions: [{ field: 'decade', op: 'is', value: 1970 }, { field: 'liked', value: false }] },
        ],
      },
    })
    // What the editor builds, the server takes.
    if ('rules' in rules) expect(SmartPlaylistRules.parse(rules.rules)).toEqual(rules.rules)
  })

  it('names the rows still to finish, and a limit that is not a count', () => {
    const blank = newCondition('title')
    const backwards = { ...newCondition('year'), op: 'between', value: '2000', to: '1990' }
    const fraction = { ...newCondition('playCount'), value: '1.5' }
    const noDate = { ...newCondition('lastPlayed'), op: 'before', value: '' }
    const result = toRules(draftWith([blank, backwards, fraction, noDate, { ...newCondition('artist'), value: 'Miles' }], { limit: 'ten' }))
    expect(result).toEqual({ unfinished: new Set([blank.key, backwards.key, fraction.key, noDate.key]), badLimit: true })
  })

  it('opens stored rules for editing as they were typed', () => {
    const stored = SmartPlaylistRules.parse({
      source: 'library', match: 'all', sort: 'random', limit: null,
      conditions: [
        { field: 'durationMs', op: 'gt', value: 420_000 },
        { field: 'lastPlayed', op: 'notInLast', value: 3, unit: 'months' },
        { field: 'addedAt', op: 'after', value: '2024-01-01' },
        { match: 'any', conditions: [{ field: 'bitrateKbps', op: 'lt', value: 256 }, { field: 'lossless', value: true }] },
      ],
    })
    const draft = toDraft(stored)
    expect(draft.rules[0]).toMatchObject({ field: 'durationMs', op: 'gt', value: '7' })
    expect(draft.rules[1]).toMatchObject({ field: 'lastPlayed', op: 'notInLast', value: '3', unit: 'months' })
    expect(toRules(draft)).toEqual({ rules: stored })
  })

  it('keeps the comparison when another field takes the same kind of value', () => {
    const artist = { ...newCondition('artist'), op: 'isNot', value: 'Drake' }
    expect(withField(artist, 'albumArtist')).toMatchObject({ key: artist.key, field: 'albumArtist', op: 'isNot', value: 'Drake' })
    // Minutes are not plays: the value starts again.
    expect(withField({ ...newCondition('durationMs'), value: '5' }, 'playCount')).toMatchObject({ field: 'playCount', op: 'eq', value: '' })
    expect(withField(artist, 'liked')).toMatchObject({ key: artist.key, field: 'liked', value: 'true' })
  })

  it('offers Rating only to people who show stars, or to a rule that has it', () => {
    expect(fieldOptions(false).map(option => option.value)).not.toContain('rating')
    expect(fieldOptions(true).map(option => option.value)).toContain('rating')
    expect(fieldOptions(false, 'rating').map(option => option.value)).toContain('rating')
  })
})
