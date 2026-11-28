import { CreatePlaylistRequest, type PlaylistDetail, type SmartField, type SmartPlaylistRules } from '@squirmy/contracts'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ListPlus, Plus, X } from 'lucide-react'
import { useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { useFormSubmit } from '@/api/errors'
import { useApi } from '@/api/services'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogFooter } from '@/components/ui/dialog'
import { IconButton } from '@/components/ui/icon-button'
import { Field, FormError, Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { plural, formatTotalDuration } from '@/lib/format'
import { useDebounced } from '@/lib/use-debounced'
import { cn } from '@/lib/utils'
import {
  booleanOptions, decadeOptions, emptyDraft, fieldInfo, fieldOptions, isDraftGroup, matchOptions, newCondition, newGroup, operatorOptions, sortOptions,
  sourceOptions, toDraft, toRules, unitOptions, withField, type Draft, type DraftCondition, type DraftGroup, type DraftRule,
} from './smart-rules'

type SmartPlaylistDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Editing this smart playlist; without it the dialog makes one. */
  playlist?: Pick<PlaylistDetail, 'name' | 'description' | 'isPublic'> & { rules: SmartPlaylistRules }
  /** Offers Rating among the fields (the user shows star ratings). */
  showRatings?: boolean
  /** Closes the dialog once it resolves; a rejection shows in the form. */
  onSubmit: (request: CreatePlaylistRequest) => Promise<unknown>
}

/** A new smart playlist, or a smart playlist's name, visibility and rules. */
export function SmartPlaylistDialog({ open, onOpenChange, ...props }: SmartPlaylistDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && <SmartPlaylistForm onDone={() => onOpenChange(false)} {...props} />}
    </Dialog>
  )
}

const MAX_RULES = 50

function SmartPlaylistForm({ playlist, showRatings = false, onSubmit, onDone }: Omit<SmartPlaylistDialogProps, 'open' | 'onOpenChange'> & { onDone: () => void }) {
  const [name, setName] = useState(playlist?.name ?? '')
  const [about, setAbout] = useState(playlist?.description ?? '')
  const [isPublic, setPublic] = useState(playlist?.isPublic ?? false)
  const [draft, setDraft] = useState<Draft>(() => (playlist ? toDraft(playlist.rules) : emptyDraft()))
  // Rows still to finish are marked once the form was sent, not while they are being typed.
  const [tried, setTried] = useState(false)
  const form = useFormSubmit(CreatePlaylistRequest, onSubmit)
  const built = useMemo(() => toRules(draft), [draft])
  const unfinished = tried && 'unfinished' in built ? built.unfinished : new Set<string>()
  const count = draft.rules.reduce((sum, rule) => sum + (isDraftGroup(rule) ? rule.conditions.length : 1), 0)

  const change = (next: Partial<Draft>) => setDraft(current => ({ ...current, ...next }))
  const changeRule = (key: string, edit: (rule: DraftRule) => DraftRule | null) =>
    setDraft(current => ({ ...current, rules: current.rules.flatMap(rule => (rule.key === key ? [edit(rule)].filter(next => next !== null) : [rule])) }))

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setTried(true)
    if (!('rules' in built)) return
    if (await form.submit({ name, description: about.trim() || null, isPublic, rules: built.rules })) onDone()
  }

  return (
    <DialogContent
      title={playlist ? 'Edit smart playlist' : 'New smart playlist'}
      description={playlist ? undefined : 'Its songs come from rules, and it keeps up as your music changes.'}
      className="sm:max-w-2xl"
    >
      <form onSubmit={event => void submit(event)} className="flex flex-col gap-4" noValidate>
        <Field label="Name" htmlFor="smart-name" error={form.errors.name}>
          <Input id="smart-name" value={name} onChange={event => setName(event.target.value)} placeholder="Jazz I haven’t played lately" maxLength={120} aria-invalid={!!form.errors.name} autoFocus={!playlist} />
        </Field>
        <Field label="Description" htmlFor="smart-description" hint="Optional" error={form.errors.description}>
          <Input id="smart-description" value={about} onChange={event => setAbout(event.target.value)} placeholder="What it’s for" maxLength={2000} />
        </Field>

        <fieldset className="flex flex-col gap-3 rounded-lg border p-3">
          <legend className="px-1 text-sm font-medium">Rules</legend>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span>Songs from</span>
            <Select size="sm" label="Songs from" value={draft.source} options={sourceOptions} onValueChange={source => change({ source })} />
            <span>that match</span>
            <Select size="sm" label="Match all or any rule" value={draft.match} options={matchOptions} onValueChange={match => change({ match })} />
            <span>of these rules</span>
          </div>
          <ul className="flex flex-col gap-2" aria-label="Rules">
            {draft.rules.map(rule => (
              <li key={rule.key}>
                {isDraftGroup(rule)
                  ? (
                      <GroupEditor
                        group={rule}
                        showRatings={showRatings}
                        unfinished={unfinished}
                        canAdd={count < MAX_RULES}
                        onChange={next => changeRule(rule.key, () => next)}
                        onRemove={() => changeRule(rule.key, () => null)}
                      />
                    )
                  : (
                      <ConditionRow
                        condition={rule}
                        showRatings={showRatings}
                        unfinished={unfinished.has(rule.key)}
                        onChange={next => changeRule(rule.key, () => next)}
                        onRemove={() => changeRule(rule.key, () => null)}
                      />
                    )}
              </li>
            ))}
          </ul>
          {!draft.rules.length && <p className="text-sm text-muted-foreground">No rules: every song {draft.source === 'library' ? 'in your library' : 'on this server'}.</p>}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={count >= MAX_RULES} onClick={() => change({ rules: [...draft.rules, newCondition()] })}><Plus />Add rule</Button>
            <Button size="sm" variant="ghost" disabled={count >= MAX_RULES} onClick={() => change({ rules: [...draft.rules, newGroup()] })}><ListPlus />Add group</Button>
          </div>
        </fieldset>

        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-2">
            <label htmlFor="smart-sort" className="text-sm font-medium leading-none">Order</label>
            <Select id="smart-sort" label="Order" value={draft.sort} options={sortOptions} onValueChange={sort => change({ sort })} className="w-44" />
          </div>
          <Field label="Limit" htmlFor="smart-limit" error={tried && 'badLimit' in built && built.badLimit ? 'A whole number of songs' : undefined}>
            <div className="flex items-center gap-2">
              <Input id="smart-limit" inputMode="numeric" value={draft.limit} onChange={event => change({ limit: event.target.value })} placeholder="No limit" className="w-28" aria-invalid={tried && 'badLimit' in built && built.badLimit} />
              <span className="text-sm text-muted-foreground">songs</span>
            </div>
          </Field>
          <MatchCount rules={'rules' in built ? built.rules : null} />
        </div>

        <label className="flex items-center justify-between gap-4 rounded-lg border px-3 py-2.5">
          <span className="min-w-0">
            <span className="block text-sm font-medium">Visible to everyone on this server</span>
            <span className="block text-xs text-muted-foreground">Other members see the songs your rules find for you.</span>
          </span>
          <Switch checked={isPublic} onCheckedChange={setPublic} aria-label="Visible to everyone on this server" />
        </label>
        {tried && 'unfinished' in built && built.unfinished.size > 0 && <FormError message="Finish the marked rules, or remove them." />}
        <FormError message={form.errors.form ?? form.errors.rules} />
        <DialogFooter>
          <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
          <Button type="submit" variant="primary" pending={form.pending} disabled={!name.trim()}>{playlist ? 'Save' : 'Create'}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  )
}

/** How many songs the rules find now, asked once typing stops. */
function MatchCount({ rules }: { rules: SmartPlaylistRules | null }) {
  const api = useApi()
  const settled = useDebounced(rules, 400, rules)
  const preview = useQuery({
    queryKey: ['smart-preview', settled],
    queryFn: () => api.userdata.previewSmartPlaylist(settled!),
    enabled: settled !== null,
    placeholderData: keepPreviousData,
    staleTime: 10_000,
  })
  let text: ReactNode = null
  if (!rules) text = 'Finish the rules to see what matches'
  else if (preview.data) text = preview.data.trackCount ? `${plural(preview.data.trackCount, 'song')}, ${formatTotalDuration(preview.data.durationMs)}` : 'No songs match yet'
  else if (preview.error) text = 'Couldn’t count the songs'
  return <p role="status" aria-live="polite" className={cn('ml-auto pb-2 text-sm text-muted-foreground tabular', preview.isFetching && 'opacity-70')}>{text}</p>
}

function GroupEditor({ group, showRatings, unfinished, canAdd, onChange, onRemove }: {
  group: DraftGroup; showRatings: boolean; unfinished: Set<string>; canAdd: boolean; onChange: (group: DraftGroup) => void; onRemove: () => void
}) {
  const changeCondition = (key: string, next: DraftCondition | null) => {
    const conditions = group.conditions.flatMap(condition => (condition.key === key ? (next ? [next] : []) : [condition]))
    if (conditions.length) onChange({ ...group, conditions })
    else onRemove()
  }
  return (
    <div className="flex flex-col gap-2 rounded-md border border-dashed p-2">
      <div className="flex items-center gap-2 text-sm">
        <span>Match</span>
        <Select size="sm" label="Match all or any rule of this group" value={group.match} options={matchOptions} onValueChange={match => onChange({ ...group, match })} />
        <span>of</span>
        <IconButton label="Remove group" size="sm" className="ml-auto" onClick={onRemove}><X /></IconButton>
      </div>
      <ul className="flex flex-col gap-2" aria-label="Rules of the group">
        {group.conditions.map(condition => (
          <li key={condition.key}>
            <ConditionRow
              condition={condition}
              showRatings={showRatings}
              unfinished={unfinished.has(condition.key)}
              onChange={next => changeCondition(condition.key, next)}
              onRemove={() => changeCondition(condition.key, null)}
            />
          </li>
        ))}
      </ul>
      <Button size="sm" variant="ghost" className="self-start" disabled={!canAdd} onClick={() => onChange({ ...group, conditions: [...group.conditions, newCondition()] })}><Plus />Add rule</Button>
    </div>
  )
}

function ConditionRow({ condition, showRatings, unfinished, onChange, onRemove }: {
  condition: DraftCondition; showRatings: boolean; unfinished: boolean; onChange: (condition: DraftCondition) => void; onRemove: () => void
}) {
  const info = fieldInfo[condition.field]
  const operators = operatorOptions(condition.field)
  const set = (next: Partial<DraftCondition>) => onChange({ ...condition, ...next })
  const label = info.label
  const textInput = (key: 'value' | 'to', aria: string, extra?: string) => (
    <Input
      value={condition[key]}
      onChange={event => set({ [key]: event.target.value })}
      aria-label={aria}
      aria-invalid={unfinished || undefined}
      inputMode={info.kind === 'number' || info.kind === 'date' ? 'decimal' : undefined}
      className={cn('h-8 min-w-0', extra)}
    />
  )
  let value: ReactNode
  switch (info.kind) {
    case 'text':
      value = textInput('value', `${label} value`, 'flex-1 basis-40')
      break
    case 'number':
      value = (
        <span className="flex flex-1 basis-40 items-center gap-2">
          {textInput('value', condition.op === 'between' ? `${label} from` : `${label} value`, 'w-24 flex-none')}
          {condition.op === 'between' && <><span className="text-sm text-muted-foreground">and</span>{textInput('to', `${label} to`, 'w-24 flex-none')}</>}
          {info.unit && <span className="text-sm text-muted-foreground">{info.unit}</span>}
        </span>
      )
      break
    case 'decade':
      value = <Select size="sm" label="Decade" value={condition.value} options={decadeOptions} onValueChange={next => set({ value: next })} />
      break
    case 'date':
      value = condition.op === 'inLast' || condition.op === 'notInLast'
        ? (
            <span className="flex flex-1 basis-40 items-center gap-2">
              {textInput('value', `${label} count`, 'w-20 flex-none')}
              <Select size="sm" label={`${label} unit`} value={condition.unit} options={unitOptions} onValueChange={unit => set({ unit })} />
            </span>
          )
        : (
            <Input
              type="date"
              value={condition.value}
              onChange={event => set({ value: event.target.value })}
              aria-label={`${label} date`}
              aria-invalid={unfinished || undefined}
              className="h-8 w-40 min-w-0"
            />
          )
      break
    case 'boolean':
      value = <Select size="sm" label={label} value={condition.value as 'true' | 'false'} options={booleanOptions} onValueChange={next => set({ value: next })} />
      break
  }
  return (
    <div className="flex flex-wrap items-center gap-2" data-unfinished={unfinished || undefined}>
      <Select size="sm" label="Field" value={condition.field} options={fieldOptions(showRatings, condition.field)} onValueChange={(field: SmartField) => onChange(withField(condition, field))} className="w-36" />
      {operators.length > 0 && (
        <Select
          size="sm"
          label={`${label} comparison`}
          value={condition.op}
          options={operators}
          onValueChange={op => set(op === 'inLast' || op === 'notInLast' ? { op, value: /^\d+$/.test(condition.value) ? condition.value : '30' } : op === 'before' || op === 'after' ? { op, value: /^\d{4}-/.test(condition.value) ? condition.value : '' } : { op })}
        />
      )}
      {info.kind === 'boolean' && <span className="text-sm text-muted-foreground">is</span>}
      {value}
      <IconButton label="Remove rule" size="sm" onClick={onRemove}><X /></IconButton>
    </div>
  )
}
