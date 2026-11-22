import { Check, Monitor, Moon, Sun } from 'lucide-react'
import { colorModes, palettes, setAppearance, useAppearance } from './preferences'

const modeIcons = { System: Monitor, Light: Sun, Dark: Moon }

export function AppearanceSettings() {
  const { palette, mode } = useAppearance()

  return (
    <div className="space-y-7">
      <fieldset>
        <legend className="mb-2 text-sm font-semibold">Color mode</legend>
        <div className="inline-flex max-w-full flex-wrap gap-1 rounded-xl border border-stroke bg-sheet p-1">
          {colorModes.map(choice => {
            const Icon = modeIcons[choice]
            return (
              <label key={choice} className="cursor-pointer">
                <input type="radio" name="color-mode" value={choice} checked={mode === choice} onChange={() => setAppearance({ mode: choice })} className="peer sr-only" />
                <span className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-muted hover:bg-overlay peer-checked:bg-selection peer-checked:text-foreground peer-focus-visible:outline-2 peer-focus-visible:outline-(--focus)">
                  <Icon aria-hidden className="size-4" />{choice}
                </span>
              </label>
            )
          })}
        </div>
      </fieldset>
      <fieldset>
        <legend className="mb-2 text-sm font-semibold">Color theme</legend>
        <div className="grid max-w-2xl grid-cols-2 gap-3 sm:grid-cols-3">
          {palettes.map(choice => (
            <label key={choice} className="min-w-0 cursor-pointer">
              <input type="radio" name="color-theme" value={choice} checked={palette === choice} onChange={() => setAppearance({ palette: choice })} className="peer sr-only" />
              <span className="block overflow-hidden rounded-xl border border-stroke bg-sheet hover:bg-overlay peer-checked:border-accent peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-(--focus)">
                <PalettePreview theme={choice.toLowerCase()} />
                <span className="flex items-center justify-between gap-1 border-t border-stroke px-3 py-2.5 text-sm font-medium">
                  {choice}
                  {palette === choice && <Check aria-hidden className="size-4 shrink-0 text-accent" />}
                </span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <p className="text-sm text-muted">Appearance preferences are saved in this browser.</p>
    </div>
  )
}

function PalettePreview({ theme }: { theme: string }) {
  return (
    <span aria-hidden data-color-theme={theme} className="flex h-20 bg-background text-foreground">
      <span className="flex w-[31%] shrink-0 flex-col gap-1.5 border-r border-stroke bg-sheet p-2">
        <span className="size-2.5 rounded-sm bg-accent" />
        <span className="h-1.5 rounded-sm bg-selection" />
        <span className="h-1.5 w-3/4 rounded-sm bg-overlay" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-2 p-3">
        <span className="h-1.5 w-1/2 rounded-full bg-foreground/70" />
        <span className="flex gap-1.5">
          <span className="h-7 flex-1 rounded bg-accent" />
          <span className="h-7 flex-1 rounded bg-surface" />
          <span className="h-7 flex-1 rounded bg-selection" />
        </span>
      </span>
    </span>
  )
}
