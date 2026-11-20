import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Slider } from './slider'

function renderSlider(value = 50) {
  const onValueChange = vi.fn()
  const onValueCommit = vi.fn()
  render(<Slider label="Volume" value={value} max={100} step={5} valueText={`${value}%`} onValueChange={onValueChange} onValueCommit={onValueCommit} />)
  return { onValueChange, onValueCommit, thumb: screen.getByRole('slider', { name: 'Volume' }) }
}

describe('Slider', () => {
  it('exposes its value to assistive technology', () => {
    const { thumb } = renderSlider(40)
    expect(thumb).toHaveAttribute('aria-valuenow', '40')
    expect(thumb).toHaveAttribute('aria-valuemax', '100')
    expect(thumb).toHaveAttribute('aria-valuetext', '40%')
  })

  it('steps with the arrow keys and commits each step', () => {
    const { thumb, onValueChange, onValueCommit } = renderSlider(50)
    fireEvent.keyDown(thumb, { key: 'ArrowRight' })
    expect(onValueChange).toHaveBeenLastCalledWith(55)
    expect(onValueCommit).toHaveBeenLastCalledWith(55)
    fireEvent.keyDown(thumb, { key: 'ArrowLeft' })
    expect(onValueChange).toHaveBeenLastCalledWith(45)
  })

  it('jumps to the ends with Home and End', () => {
    const { thumb, onValueChange } = renderSlider(50)
    fireEvent.keyDown(thumb, { key: 'End' })
    expect(onValueChange).toHaveBeenLastCalledWith(100)
    fireEvent.keyDown(thumb, { key: 'Home' })
    expect(onValueChange).toHaveBeenLastCalledWith(0)
  })
})
