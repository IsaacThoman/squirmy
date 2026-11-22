import { Check, Monitor, Moon, Sun } from 'lucide-react'
import { useSyncExternalStore } from 'react'
import { getAppearance, saveAppearance, subscribeAppearance, themes, type Appearance } from './appearance'

const modes = [
  { id: 'system', label: 'System', icon: Monitor },
  { id: 'light', label: 'Light', icon: Sun },
  { id: 'dark', label: 'Dark', icon: Moon },
] as const

export function AppearanceSettings() {
  const appearance = useSyncExternalStore(subscribeAppearance, getAppearance)

  function change(patch: Partial<Appearance>) {
    saveAppearance({ ...appearance, ...patch })
  }

  return (
    <section aria-labelledby="appearance-title" className="rounded-xl border border-stroke bg-sheet p-4 sm:p-6">
      <h2 id="appearance-title" className="text-xl font-bold tracking-tight">Appearance</h2>
      <p className="mt-1 text-sm text-muted">Your theme and color mode are saved in this browser.</p>

      <fieldset className="mt-6 min-w-0">
        <legend className="text-sm font-semibold">Color mode</legend>
        <div className="mt-2.5 flex flex-wrap gap-2">
          {modes.map(({ id, label, icon: Icon }) => (
            <label key={id} className="cursor-pointer">
              <input type="radio" name="color-mode" value={id} checked={appearance.mode === id} onChange={() => change({ mode: id })} className="peer sr-only" />
              <span className="flex min-h-10 items-center gap-2.5 rounded-lg border border-stroke bg-background px-3.5 text-sm font-semibold text-muted transition-colors hover:bg-overlay peer-checked:border-accent peer-checked:bg-selection peer-checked:text-accent peer-focus-visible:ring-2 peer-focus-visible:ring-accent">
                <Icon aria-hidden className="size-4" />{label}
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="mt-7 min-w-0">
        <legend className="text-sm font-semibold">Theme</legend>
        <div className="mt-2.5 grid grid-cols-2 gap-2.5 sm:grid-cols-3 xl:grid-cols-5">
          {themes.map(theme => (
            <label key={theme.id} className="cursor-pointer">
              <input type="radio" name="theme" value={theme.id} checked={appearance.theme === theme.id} onChange={() => change({ theme: theme.id })} className="peer sr-only" />
              <span className="block rounded-lg border border-stroke bg-background p-2 transition-colors hover:bg-overlay peer-checked:border-accent peer-checked:bg-selection peer-focus-visible:ring-2 peer-focus-visible:ring-accent">
                <span aria-hidden className="block overflow-hidden rounded-md border border-stroke">
                  <ThemePreview theme={theme.id} />
                </span>
                <span className="flex min-h-8 items-center justify-between gap-1 px-0.5 pt-1.5 text-[13px] font-semibold">
                  {theme.name}
                  {appearance.theme === theme.id && <Check aria-hidden className="size-4 shrink-0 text-accent" />}
                </span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
    </section>
  )
}

function ThemePreview({ theme }: { theme: Appearance['theme'] }) {
  return (
    <span data-theme={theme} className="grid h-19 grid-cols-[26%_1fr] gap-1 bg-sheet p-1.5">
      <span className="flex flex-col gap-1.5 pt-1.5">
        <span className="h-1 w-2/3 rounded-full bg-accent" />
        <span className="h-1 w-4/5 rounded-full bg-selection" />
        <span className="h-1 w-1/2 rounded-full bg-stroke" />
      </span>
      <span className="flex min-w-0 flex-col justify-between gap-1 rounded bg-background p-1.5">
        <span className="block h-1 w-1/2 rounded-full bg-muted/70" />
        <span className="grid grid-cols-2 gap-1">
          <span className="h-5 rounded-sm bg-accent/35" />
          <span className="h-5 rounded-sm bg-selection" />
        </span>
        <span className="block h-1 w-full rounded-full bg-stroke" />
      </span>
    </span>
  )
}
