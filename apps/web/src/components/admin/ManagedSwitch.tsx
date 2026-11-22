import type { FormErrors } from '@/api/errors'
import { DialogContent } from '@/components/ui/dialog'
import { Switch } from '@/components/ui/switch'
import { DialogForm } from './AdminLayout'
import { OptionGroup } from './Panel'

/** What managed means, said the same way wherever a folder becomes managed. */
export const MANAGED_EXPLAINED = 'Squirmy may rename, move and tag the files in this folder once their music is identified. Nothing changes until you preview it in Organize and apply it, and every batch can be undone.'

type SwitchProps = { checked: boolean; onChange: (checked: boolean) => void }

/** A labelled switch as a row of an `OptionGroup`, for the options of a library folder. */
export function SwitchRow({ label, description, checked, onChange }: SwitchProps & { label: string; description: string }) {
  return (
    <label className="flex items-center justify-between gap-4 px-3 py-2.5">
      <span className="min-w-0">
        <span className="block text-sm font-medium">{label}</span>
        <span className="mt-0.5 block text-xs text-muted-foreground">{description}</span>
      </span>
      <Switch aria-label={label} checked={checked} onCheckedChange={onChange} />
    </label>
  )
}

/** The switch that makes a folder managed, as a row of an `OptionGroup`. */
export function ManagedSwitchRow({ checked, onChange }: SwitchProps) {
  return (
    <SwitchRow
      label="Let Squirmy organize this folder"
      description="Identified music is renamed into Artist/Album folders. Every move can be previewed and undone."
      checked={checked}
      onChange={onChange}
    />
  )
}

/** The same switch on a card of its own, for a form with no other options. */
export function ManagedSwitch(props: SwitchProps) {
  return <OptionGroup><ManagedSwitchRow {...props} /></OptionGroup>
}

/** The confirmation before a folder becomes managed, inside a `Dialog`: it lets the server change files, so it is said plainly first. */
export function ManagedConfirmation({ name, errors, pending, onConfirm }: { name: string; errors: FormErrors; pending: boolean; onConfirm: () => void }) {
  return (
    <DialogContent title={`Let Squirmy manage ${name}?`} description={MANAGED_EXPLAINED}>
      <DialogForm onSubmit={onConfirm} errors={errors} pending={pending} submitLabel="Make managed">
        <p className="rounded-lg border bg-muted/40 px-3 py-2.5 text-sm text-muted-foreground">
          Files stay where they are until you apply a batch. Tags are only written when you ask for it, and undoing a batch moves the files back but leaves written tags as they are.
        </p>
      </DialogForm>
    </DialogContent>
  )
}
