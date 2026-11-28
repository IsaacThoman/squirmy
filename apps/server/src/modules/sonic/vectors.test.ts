import { describe, expect, it } from 'vitest'
import { VECTOR_LENGTH } from './dsp/analyzer.js'
import { buildIndex, centroid, neighbourhood, vectorOf } from './vectors.js'

/** A raw vector near `base` in every element, offset by `offset` in the first `spread` ones. */
const raw = (base: number, offset = 0, spread = VECTOR_LENGTH) => Array.from({ length: VECTOR_LENGTH }, (_, d) => base + (d < spread ? offset : 0) + d * 0.01)

describe('sonic vectors', () => {
  const rows = [
    { id: 'a', vector: raw(1) },
    { id: 'b', vector: raw(1, 0.05) },
    { id: 'c', vector: raw(1, 0.4) },
    { id: 'd', vector: raw(5) },
    { id: 'e', vector: raw(5, 0.1) },
  ]
  const index = buildIndex(rows)

  it('standardizes every element over the library', () => {
    expect(index.ids).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(index.mean[0]).toBeCloseTo((1 + 1.05 + 1.4 + 5 + 5.1) / 5, 6)
    const column = index.ids.map((id) => vectorOf(index, id)![0]!)
    expect(column.reduce((sum, value) => sum + value, 0)).toBeCloseTo(0, 5)
    expect(vectorOf(index, 'zz')).toBeNull()
  })

  it('finds the nearest tracks and ranks distances', () => {
    const near = neighbourhood(index, vectorOf(index, 'a')!, 2, new Set(['a']))
    expect(near.nearest.map((one) => one.id)).toEqual(['b', 'c'])
    expect(near.percentile(0)).toBe(0)
    expect(near.percentile(near.sorted.at(-1)! + 1)).toBe(1)
    expect(near.percentile(near.nearest[0]!.distance)).toBeLessThan(near.percentile(near.sorted.at(-1)!))
  })

  it('averages seeds by weight', () => {
    const middle = centroid([{ vector: vectorOf(index, 'a')!, weight: 1 }, { vector: vectorOf(index, 'd')!, weight: 1 }])!
    const near = neighbourhood(index, middle, 5)
    expect(near.nearest).toHaveLength(5)
    expect(centroid([])).toBeNull()
  })

  it('ignores an element that does not vary', () => {
    const flat = buildIndex([{ id: 'x', vector: raw(2) }, { id: 'y', vector: raw(2) }])
    expect(vectorOf(flat, 'x')!.every((value) => value === 0)).toBe(true)
  })
})
