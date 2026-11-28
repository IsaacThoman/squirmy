import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Kbd } from '@/components/ui/feedback'
import { SHORTCUT_GROUPS } from './shortcuts'

function Keys({ keys }: { keys: string[][] }) {
  return (
    <span className="flex shrink-0 flex-wrap items-center justify-end gap-1 text-xs text-muted-foreground">
      {keys.map((combo, index) => (
        <span key={index} className="flex items-center gap-1">
          {index > 0 && <span aria-hidden>or</span>}
          {combo.map(key => <Kbd key={key} className="min-w-5 text-center text-[11px]">{key}</Kbd>)}
        </span>
      ))}
    </span>
  )
}

/** The `?` sheet: what each key does, in the groups the docs use. */
export function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Keyboard shortcuts" className="sm:max-w-lg">
        <div className="flex flex-col gap-5">
          {SHORTCUT_GROUPS.map(group => (
            <section key={group.title} aria-label={group.title}>
              <h3 className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{group.title}</h3>
              <dl className="flex flex-col">
                {group.shortcuts.map(shortcut => (
                  <div key={shortcut.label} className="flex items-center justify-between gap-4 border-b py-1.5 text-sm last:border-b-0">
                    <dt>{shortcut.label}</dt>
                    <dd><Keys keys={shortcut.keys} /></dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
