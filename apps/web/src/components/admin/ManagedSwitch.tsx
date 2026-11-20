import { Switch } from '@/components/ui/switch'

/** What managed means, said the same way wherever a folder becomes managed. */
export const MANAGED_EXPLAINED = 'Squirmy may rename, move and tag the files in this folder once their music is identified. Nothing changes until you preview it in Organize and apply it, and every batch can be undone.'

/** A labelled switch on a surface row, for the options of a library folder. */
export function SwitchRow({ label, description, checked, onChange }: { label: string; description: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="flex items-center justify-between gap-4 rounded-xl bg-surface px-3.5 py-3">
      <span>
        <span className="block text-sm font-semibold">{label}</span>
        <span className="block text-xs text-muted">{description}</span>
      </span>
      <Switch aria-label={label} checked={checked} onCheckedChange={onChange} />
    </label>
  )
}

export function ManagedSwitch({ checked, onChange }: { checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <SwitchRow
      label="Let Squirmy organize this folder"
      description="Identified music is renamed into Artist/Album folders. Every move can be previewed and undone."
      checked={checked}
      onChange={onChange}
    />
  )
}
