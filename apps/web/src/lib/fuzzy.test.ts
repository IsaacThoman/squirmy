import { describe, expect, it } from 'vitest'
import { fuzzyFilter, fuzzyScore } from './fuzzy'

describe('fuzzyScore', () => {
  it('matches letters in order, anywhere, ignoring case and accents', () => {
    expect(fuzzyScore('nxt', 'Next song')).not.toBeNull()
    expect(fuzzyScore('cafe', 'Café Bleu')).not.toBeNull()
    expect(fuzzyScore('txn', 'Next song')).toBeNull()
  })

  it('counts the start of words and runs of letters', () => {
    expect(fuzzyScore('sh', 'Shuffle')!).toBeGreaterThan(fuzzyScore('sh', 'Fresh air')!)
    expect(fuzzyScore('queue', 'Show queue')!).toBeGreaterThan(fuzzyScore('queue', 'Quiet music evening up early')!)
    expect(fuzzyScore('play', 'Play')!).toBeGreaterThan(fuzzyScore('play', 'Pop out player')!)
  })
})

describe('fuzzyFilter', () => {
  const commands = ['Play', 'Next song', 'Previous song', 'Turn on shuffle', 'Show queue', 'Pop out player']

  it('keeps what matches, best first', () => {
    expect(fuzzyFilter(commands, 'shuf', text => [text])).toEqual(['Turn on shuffle'])
    expect(fuzzyFilter(commands, 'song', text => [text])).toEqual(['Next song', 'Previous song'])
    expect(fuzzyFilter(commands, 'play', text => [text])[0]).toBe('Play')
  })

  it('matches other words an item answers to', () => {
    const items = [{ label: 'Next song', keywords: ['skip'] }, { label: 'Mute', keywords: ['volume'] }]
    expect(fuzzyFilter(items, 'skip', item => [item.label, ...item.keywords])).toEqual([items[0]])
  })

  it('keeps everything for an empty query', () => {
    expect(fuzzyFilter(commands, '  ', text => [text])).toEqual(commands)
  })
})
