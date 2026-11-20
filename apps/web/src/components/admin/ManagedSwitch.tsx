import { Switch } from '@/components/ui/switch'

export function ManagedSwitch({ checked, onChange }: { checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="flex items-center justify-between gap-4 rounded-xl bg-surface px-3.5 py-3">
      <span>
        <span className="block text-sm font-semibold">Let Squirmy organize this folder</span>
        <span className="block text-xs text-muted">Identified music is renamed into Artist/Album folders. Every move can be previewed and undone.</span>
      </span>
      <Switch checked={checked} onCheckedChange={onChange} />
    </label>
  )
}
