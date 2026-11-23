import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Button } from './button'
import { IconButton } from './icon-button'
import { inputClass } from './input'
import { SearchField } from './search-field'
import { Slider } from './slider'
import { Switch } from './switch'
import { pillClass } from './tabs'

const styles = readFileSync(join(import.meta.dirname, '../../index.css'), 'utf8')

// jsdom has no pointer media, so these check that each primitive asks for the 44 px rule;
// `scripts/e2e-touch-targets.mjs` presses every control in Chromium to check it is kept.
describe('touch targets', () => {
  it('are a 44 px square centered on the control, only where the pointer is coarse', () => {
    const rule = styles.slice(styles.indexOf('@utility touch-target'))
    expect(rule).toMatch(/^@utility touch-target \{\s*@media \(pointer: coarse\) \{\s*&::after \{/)
    expect(rule).toContain('width: max(100%, 2.75rem);')
    expect(rule).toContain('height: max(100%, 2.75rem);')
  })

  it('reach past every icon button, whatever its size', () => {
    render(<IconButton label="More" size="xs" tooltip={false}>…</IconButton>)
    expect(screen.getByRole('button', { name: 'More' })).toHaveClass('touch-target', 'relative')
  })

  it('make every button 44 px tall and wide, and press a link-styled one through a square', () => {
    render(<><Button size="sm">Save</Button><Button variant="link">Read more</Button></>)
    expect(screen.getByRole('button', { name: 'Save' })).toHaveClass('pointer-coarse:min-h-11', 'pointer-coarse:min-w-11')
    expect(screen.getByRole('button', { name: 'Read more' })).toHaveClass('touch-target', 'relative', 'pointer-coarse:min-h-0')
  })

  it('reach past a switch and fill a slider’s height', () => {
    render(<><Switch aria-label="Autoplay" /><Slider label="Volume" value={50} max={100} onValueChange={vi.fn()} /></>)
    expect(screen.getByRole('switch', { name: 'Autoplay' })).toHaveClass('touch-target', 'relative')
    expect(screen.getByRole('slider', { name: 'Volume' }).closest('[data-orientation]:not([role])')).toHaveClass('pointer-coarse:h-11')
  })

  it('make fields, pills and a search field’s clear button a finger’s size', () => {
    expect(inputClass).toContain('pointer-coarse:min-h-11')
    expect(pillClass).toContain('pointer-coarse:h-11')
    expect(pillClass).toContain('pointer-coarse:min-w-11')
    render(<SearchField value="radiohead" onValueChange={vi.fn()} />)
    expect(screen.getByRole('searchbox')).toHaveClass('pointer-coarse:h-11')
    expect(screen.getByRole('button', { name: 'Clear search' })).toHaveClass('touch-target')
  })
})
