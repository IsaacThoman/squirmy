import { act, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { LibraryFailures, LibraryFailuresContext } from '@/player/library-context'
import { renderWithApp } from '@/test/render'
import { PlayActions } from './CollectionHeader'
import { SaveHeart } from './LibrarySave'

describe('a refused library change', () => {
  it('says so beside the heart that made it, held open, and lets it go', () => {
    const failures = new LibraryFailures()
    renderWithApp(
      <LibraryFailuresContext value={failures}>
        <SaveHeart id="amber" liked={false} onToggle={() => {}} title="Amber" tooltip={false} />
        <SaveHeart id="riverside" liked={false} onToggle={() => {}} title="Riverside" tooltip={false} />
      </LibraryFailuresContext>,
    )
    const heart = screen.getByRole('button', { name: 'Save Amber to library' })
    expect(screen.queryByRole('tooltip')).toBeNull()
    act(() => failures.fail('save:amber', 'Couldn’t save. Try again.', 'Couldn’t save “Amber” to your library. Try again.'))
    // Only that heart says it, in the error color, and it is the same button as before.
    expect(screen.getByRole('tooltip')).toHaveTextContent('Couldn’t save. Try again.')
    expect(document.querySelector('[data-tone="error"]')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Save Amber to library' })).toBe(heart)
    act(() => failures.clear('save:amber'))
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('says so beside the Wantlist button of the album or artist page', () => {
    const failures = new LibraryFailures()
    renderWithApp(
      <LibraryFailuresContext value={failures}>
        <PlayActions id="glass-city" wanted={false} onWant={() => {}} />
      </LibraryFailuresContext>,
    )
    act(() => failures.fail('want:glass-city', 'Couldn’t add to your Wantlist. Try again.', 'Couldn’t add “Glass City” to your Wantlist. Try again.'))
    expect(screen.getByRole('tooltip')).toHaveTextContent('Couldn’t add to your Wantlist. Try again.')
  })
})
