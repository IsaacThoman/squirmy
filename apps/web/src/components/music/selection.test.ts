import { describe, expect, it, vi } from 'vitest'
import { Selection } from './selection'

const keys = ['a', 'b', 'c', 'd', 'e']

function selection() {
  const picked = new Selection()
  picked.setKeys(keys)
  return picked
}

describe('Selection', () => {
  it('picks one row with a click, and only that row with the next', () => {
    const picked = selection()
    picked.click(1)
    expect(picked.indexes()).toEqual([1])
    picked.click(3)
    expect(picked.indexes()).toEqual([3])
  })

  it('adds and removes rows with ⌘/Ctrl-click', () => {
    const picked = selection()
    picked.click(0)
    picked.click(2, { toggle: true })
    picked.click(4, { toggle: true })
    expect(picked.indexes()).toEqual([0, 2, 4])
    picked.click(2, { toggle: true })
    expect(picked.indexes()).toEqual([0, 4])
  })

  it('picks the range from the last click with Shift-click, either way, and adds it with ⌘/Ctrl too', () => {
    const picked = selection()
    picked.click(3)
    picked.click(1, { range: true })
    expect(picked.indexes()).toEqual([1, 2, 3])
    picked.click(4, { range: true })
    expect(picked.indexes()).toEqual([3, 4])
    picked.click(0, { toggle: true })
    picked.click(1, { range: true, toggle: true })
    expect(picked.indexes()).toEqual([0, 1, 3, 4])
  })

  it('grows and shrinks a range with Shift+arrows, and stops at the ends', () => {
    const picked = selection()
    expect(picked.extend(2, 1)).toBe(3)
    expect(picked.indexes()).toEqual([2, 3])
    expect(picked.extend(3, 1)).toBe(4)
    expect(picked.extend(4, 1)).toBeUndefined()
    expect(picked.extend(4, -1)).toBe(3)
    expect(picked.indexes()).toEqual([2, 3])
  })

  it('picks all and lets go', () => {
    const picked = selection()
    picked.selectAll()
    expect(picked.size).toBe(5)
    picked.clear()
    expect(picked.size).toBe(0)
  })

  it('lets go of rows that leave the list, and keeps the rest by key wherever they move', () => {
    const picked = selection()
    picked.click(1)
    picked.click(3, { toggle: true })
    picked.setKeys(['d', 'a', 'c', 'e'])
    expect(picked.indexes()).toEqual([0])
    expect(picked.has('d')).toBe(true)
  })

  it('tells its readers only when the picked rows change', () => {
    const picked = selection()
    const listener = vi.fn()
    picked.subscribe(listener)
    picked.click(1)
    picked.click(1)
    picked.setKeys([...keys])
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
