import { Check, Monitor, Moon, Sun } from 'lucide-react'
import { useId } from 'react'
import { Row } from '@/components/ui/section'
import { setAppearanceMode, setColorTheme, useAppearance, type AppearanceMode } from '@/lib/appearance'
import { COLOR_THEMES, resolvePalette, type ColorTheme, type ThemeAppearance } from '@/lib/color-themes'
import { cn } from '@/lib/utils'

const modes: { id: AppearanceMode; label: string; icon: typeof Sun }[] = [
  { id: 'light', label: 'Light', icon: Sun },
  { id: 'dark', label: 'Dark', icon: Moon },
  { id: 'system', label: 'System', icon: Monitor },
]

/** Light, dark or the system's choice, and the color theme. Both are kept in this browser. */
export function AppearanceSettings() {
  const appearance = useAppearance()
  const modeLabel = useId()
  const themeLabel = useId()
  return (
    <>
      <Row label={<span id={modeLabel}>Theme</span>} description="System follows your device between light and dark.">
        <div role="group" aria-labelledby={modeLabel} className="flex w-full rounded-lg border p-0.5 @xl:w-auto">
          {modes.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              aria-pressed={appearance.mode === id}
              onClick={() => setAppearanceMode(id)}
              className={cn(
                'flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring @xl:flex-none',
                // Filled in the action color: a quiet fill is hard to tell from the segments beside it.
                appearance.mode === id ? 'bg-primary font-medium text-primary-foreground focus-visible:ring-offset-1 focus-visible:ring-offset-background' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
              )}
            >
              <Icon aria-hidden className="size-4" />{label}
            </button>
          ))}
        </div>
      </Row>
      <div>
        <div id={themeLabel} className="text-sm font-medium">Color theme</div>
        <p className="mt-0.5 text-xs text-muted-foreground">Each theme has light and dark colors. Your choice is kept in this browser.</p>
        <div role="group" aria-labelledby={themeLabel} className="mt-3 grid grid-cols-2 gap-2 @md:grid-cols-3">
          {COLOR_THEMES.map(theme => {
            const selected = theme.id === appearance.theme
            return (
              <button
                key={theme.id}
                type="button"
                aria-pressed={selected}
                onClick={() => setColorTheme(theme.id)}
                className={cn(
                  'min-w-0 rounded-lg border p-1.5 text-left outline-none transition-colors hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring',
                  selected && 'ring-2 ring-foreground ring-offset-2 ring-offset-background',
                )}
              >
                <ThemePreview theme={theme} appearance={appearance.resolved} />
                <span className="mt-1.5 flex items-center gap-1 px-0.5 text-sm">
                  <span className="min-w-0 truncate">{theme.name}</span>
                  {selected && <Check aria-hidden className="size-3.5 shrink-0" />}
                </span>
              </button>
            )
          })}
        </div>
      </div>
    </>
  )
}

/** The app in miniature, in a theme's colors: the sidebar, a row of covers and the player. */
function ThemePreview({ theme, appearance }: { theme: ColorTheme; appearance: ThemeAppearance }) {
  const palette = resolvePalette(theme[appearance])
  return (
    <div aria-hidden className="flex h-16 overflow-hidden rounded-md border" style={{ backgroundColor: palette.background, borderColor: palette.border }}>
      <div className="flex w-1/4 flex-col gap-1 p-1.5" style={{ backgroundColor: palette.sidebar, borderRight: `1px solid ${palette.sidebarBorder}` }}>
        <div className="h-1.5 rounded-full" style={{ backgroundColor: palette.sidebarSelection }} />
        <div className="h-1 w-3/4 rounded-full" style={{ backgroundColor: palette.mutedText, opacity: 0.6 }} />
        <div className="h-1 w-2/3 rounded-full" style={{ backgroundColor: palette.mutedText, opacity: 0.6 }} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1 items-center gap-1.5 px-2">
          {[0.9, 0.55, 0.3].map(strength => <div key={strength} className="aspect-square h-5 rounded-[3px]" style={{ backgroundColor: palette.action, opacity: strength }} />)}
          <div className="ml-1 flex min-w-0 flex-1 flex-col gap-1">
            <div className="h-1 w-4/5 rounded-full" style={{ backgroundColor: palette.text, opacity: 0.75 }} />
            <div className="h-1 w-1/2 rounded-full" style={{ backgroundColor: palette.mutedText }} />
          </div>
        </div>
        <div className="flex h-4 items-center gap-1.5 px-2" style={{ backgroundColor: palette.sidebar, borderTop: `1px solid ${palette.sidebarBorder}` }}>
          <div className="size-2 rounded-full" style={{ backgroundColor: palette.action }} />
          <div className="h-0.5 flex-1 rounded-full" style={{ backgroundColor: palette.mutedText, opacity: 0.5 }} />
        </div>
      </div>
    </div>
  )
}
