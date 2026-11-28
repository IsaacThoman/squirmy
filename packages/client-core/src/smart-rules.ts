import type {
  SmartCondition, SmartDateUnit, SmartField, SmartGroup, SmartMatch, SmartPlaylistRules, SmartRule, SmartSort, SmartSource,
} from '@squirmy/contracts'

/** One choice of a rule editor's menus: the value it stands for and what it says. */
export type RuleOption<T extends string> = { value: T; label: string }

/**
 * The smart playlist rule editor's model, shared by the web and the phone. A rule being edited
 * keeps what was typed as text, so a field can be empty or half-typed while it is edited;
 * `toRules` turns the draft into the contract's rules, or says which rows are not finished.
 */
type Kind = 'text' | 'number' | 'decade' | 'date' | 'boolean'

type FieldInfo = { label: string; kind: Kind; unit?: string; scale?: number; ratings?: boolean }

/** What each field is called and how its value is typed. `scale` turns the shown unit into the contract's. */
export const fieldInfo: Record<SmartField, FieldInfo> = {
  title: { label: 'Title', kind: 'text' },
  artist: { label: 'Artist', kind: 'text' },
  albumArtist: { label: 'Album artist', kind: 'text' },
  album: { label: 'Album', kind: 'text' },
  genre: { label: 'Genre', kind: 'text' },
  codec: { label: 'Format', kind: 'text' },
  year: { label: 'Year', kind: 'number' },
  decade: { label: 'Decade', kind: 'decade' },
  durationMs: { label: 'Length', kind: 'number', unit: 'min', scale: 60_000 },
  playCount: { label: 'Plays', kind: 'number' },
  rating: { label: 'Rating', kind: 'number', unit: 'stars', ratings: true },
  bitrateKbps: { label: 'Bitrate', kind: 'number', unit: 'kbps' },
  sampleRateHz: { label: 'Sample rate', kind: 'number', unit: 'Hz' },
  addedAt: { label: 'Date added', kind: 'date' },
  lastPlayed: { label: 'Last played', kind: 'date' },
  liked: { label: 'Liked', kind: 'boolean' },
  lossless: { label: 'Lossless', kind: 'boolean' },
}

/** The fields offered, in menu order. Rating only for people who show stars, or a rule that has one. */
export function fieldOptions(showRatings: boolean, current?: SmartField): RuleOption<SmartField>[] {
  return (Object.keys(fieldInfo) as SmartField[])
    .filter(field => !fieldInfo[field].ratings || showRatings || field === current)
    .map(field => ({ value: field, label: fieldInfo[field].label }))
}

const textOps: RuleOption<string>[] = [
  { value: 'contains', label: 'contains' },
  { value: 'notContains', label: 'doesn’t contain' },
  { value: 'is', label: 'is' },
  { value: 'isNot', label: 'is not' },
]
const numberOps: RuleOption<string>[] = [
  { value: 'eq', label: 'is' },
  { value: 'ne', label: 'is not' },
  { value: 'gt', label: 'is more than' },
  { value: 'lt', label: 'is less than' },
  { value: 'between', label: 'is between' },
]
const yearOps: RuleOption<string>[] = [
  { value: 'eq', label: 'is' },
  { value: 'ne', label: 'is not' },
  { value: 'gt', label: 'is after' },
  { value: 'lt', label: 'is before' },
  { value: 'between', label: 'is between' },
]
const decadeOps: RuleOption<string>[] = [{ value: 'is', label: 'is' }, { value: 'isNot', label: 'is not' }]
const dateOps: RuleOption<string>[] = [
  { value: 'inLast', label: 'is in the last' },
  { value: 'notInLast', label: 'is not in the last' },
  { value: 'before', label: 'is before' },
  { value: 'after', label: 'is on or after' },
]

export function operatorOptions(field: SmartField): RuleOption<string>[] {
  switch (fieldInfo[field].kind) {
    case 'text': return textOps
    case 'number': return field === 'year' ? yearOps : numberOps
    case 'decade': return decadeOps
    case 'date': return dateOps
    case 'boolean': return []
  }
}

export const unitOptions: RuleOption<SmartDateUnit>[] = [
  { value: 'days', label: 'days' },
  { value: 'weeks', label: 'weeks' },
  { value: 'months', label: 'months' },
  { value: 'years', label: 'years' },
]

export const booleanOptions: RuleOption<'true' | 'false'>[] = [{ value: 'true', label: 'yes' }, { value: 'false', label: 'no' }]

export const decadeOptions: RuleOption<string>[] = Array.from({ length: 13 }, (_, index) => {
  const decade = 1900 + index * 10
  return { value: String(decade), label: `${decade}s` }
}).reverse()

export const sourceOptions: RuleOption<SmartSource>[] = [
  { value: 'library', label: 'Your library' },
  { value: 'server', label: 'All music on this server' },
]

export const matchOptions: RuleOption<SmartMatch>[] = [{ value: 'all', label: 'all' }, { value: 'any', label: 'any' }]

export const sortOptions: RuleOption<SmartSort>[] = [
  { value: 'random', label: 'Random' },
  { value: 'mostPlayed', label: 'Most played' },
  { value: 'leastPlayed', label: 'Least played' },
  { value: 'recentlyAdded', label: 'Recently added' },
  { value: 'recentlyPlayed', label: 'Recently played' },
  { value: 'title', label: 'Title' },
  { value: 'artist', label: 'Artist' },
  { value: 'year', label: 'Year' },
]

/** One rule row as typed. `value` and `to` are text until the draft is turned into rules. */
export type DraftCondition = { key: string; field: SmartField; op: string; value: string; to: string; unit: SmartDateUnit }
export type DraftGroup = { key: string; match: SmartMatch; conditions: DraftCondition[] }
export type DraftRule = DraftCondition | DraftGroup
export type Draft = { source: SmartSource; match: SmartMatch; rules: DraftRule[]; sort: SmartSort; limit: string }

export const isDraftGroup = (rule: DraftRule): rule is DraftGroup => 'conditions' in rule

let keys = 0
const nextKey = () => `rule-${++keys}`

/** A fresh row for the field, with the field's first operator and a sensible starting value. */
export function newCondition(field: SmartField = 'genre'): DraftCondition {
  const kind = fieldInfo[field].kind
  return {
    key: nextKey(),
    field,
    op: operatorOptions(field)[0]?.value ?? 'is',
    value: kind === 'decade' ? '1990' : kind === 'boolean' ? 'true' : kind === 'date' ? '30' : '',
    to: '',
    unit: 'days',
  }
}

/** The row with another field: the operator and value carry over when they still make sense. */
export function withField(condition: DraftCondition, field: SmartField): DraftCondition {
  const fresh = newCondition(field)
  const sameKind = fieldInfo[field].kind === fieldInfo[condition.field].kind && fieldInfo[field].scale === fieldInfo[condition.field].scale
  const op = operatorOptions(field).some(option => option.value === condition.op) ? condition.op : fresh.op
  return sameKind ? { ...condition, field, op } : { ...fresh, key: condition.key }
}

export function newGroup(): DraftGroup {
  return { key: nextKey(), match: 'any', conditions: [newCondition()] }
}

export const emptyDraft = (): Draft => ({ source: 'library', match: 'all', rules: [newCondition()], sort: 'random', limit: '' })

const whole = (text: string) => (/^\d+$/.test(text.trim()) ? Number(text.trim()) : null)
/** A number as typed, in the field's shown unit: minutes may have a fraction. */
const amount = (text: string, scale = 1) => {
  const trimmed = text.trim()
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null
  const value = Math.round(Number(trimmed) * scale)
  return scale === 1 && !Number.isInteger(Number(trimmed)) ? null : value
}

/** The contract's condition for a row, or null while it is not finished. */
export function toCondition(draft: DraftCondition): SmartCondition | null {
  const info = fieldInfo[draft.field]
  switch (info.kind) {
    case 'text': {
      const value = draft.value.trim()
      return value ? { field: draft.field, op: draft.op, value } as SmartCondition : null
    }
    case 'number': {
      const value = amount(draft.value, info.scale)
      if (value === null) return null
      if (draft.op !== 'between') return { field: draft.field, op: draft.op, value } as SmartCondition
      const to = amount(draft.to, info.scale)
      return to === null || to < value ? null : { field: draft.field, op: 'between', value, to } as SmartCondition
    }
    case 'decade':
      return { field: 'decade', op: draft.op as 'is' | 'isNot', value: Number(draft.value) }
    case 'date': {
      if (draft.op === 'inLast' || draft.op === 'notInLast') {
        const value = whole(draft.value)
        return value && value > 0 ? { field: draft.field, op: draft.op, value, unit: draft.unit } as SmartCondition : null
      }
      return /^\d{4}-\d{2}-\d{2}$/.test(draft.value) ? { field: draft.field, op: draft.op, value: draft.value } as SmartCondition : null
    }
    case 'boolean':
      return { field: draft.field as 'liked' | 'lossless', value: draft.value === 'true' }
  }
}

/** The rules a draft says, or the keys of the rows still to finish (and whether the limit is not a count). */
export function toRules(draft: Draft): { rules: SmartPlaylistRules } | { unfinished: Set<string>; badLimit: boolean } {
  const unfinished = new Set<string>()
  const convert = (condition: DraftCondition) => {
    const converted = toCondition(condition)
    if (!converted) unfinished.add(condition.key)
    return converted
  }
  const rules: SmartRule[] = draft.rules.flatMap((rule): SmartRule[] => {
    if (!isDraftGroup(rule)) return [convert(rule)].filter(condition => condition !== null)
    const conditions = rule.conditions.map(convert).filter(condition => condition !== null)
    return conditions.length ? [{ match: rule.match, conditions } satisfies SmartGroup] : []
  })
  const limit = draft.limit.trim() ? whole(draft.limit) : null
  const badLimit = Boolean(draft.limit.trim()) && (limit === null || limit < 1)
  if (unfinished.size || badLimit) return { unfinished, badLimit }
  return { rules: { source: draft.source, match: draft.match, conditions: rules, sort: draft.sort, limit } }
}

/** A stored rule as a row to edit. */
function fromCondition(condition: SmartCondition): DraftCondition {
  const info = fieldInfo[condition.field]
  const base = { ...newCondition(condition.field), field: condition.field }
  if ('op' in condition) base.op = condition.op
  if (info.kind === 'number' && 'value' in condition && typeof condition.value === 'number') {
    const scale = info.scale ?? 1
    base.value = String(condition.value / scale)
    if ('to' in condition && condition.to !== undefined) base.to = String(condition.to / scale)
    return base
  }
  if (info.kind === 'date' && 'unit' in condition && condition.unit) base.unit = condition.unit
  base.value = String(condition.value)
  return base
}

export function toDraft(rules: SmartPlaylistRules): Draft {
  return {
    source: rules.source,
    match: rules.match,
    sort: rules.sort,
    limit: rules.limit === null ? '' : String(rules.limit),
    rules: rules.conditions.map((rule): DraftRule => ('match' in rule
      ? { key: nextKey(), match: rule.match, conditions: rule.conditions.map(fromCondition) }
      : fromCondition(rule))),
  }
}
