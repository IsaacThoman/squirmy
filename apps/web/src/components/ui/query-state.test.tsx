import { ApiError } from '@squirmy/client-core'
import { useQuery } from '@tanstack/react-query'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { renderWithApp } from '@/test/render'
import { LoadError, QueryState } from './query-state'

/** A refusal the query client does not retry, so the test does not wait out its backoff. */
const refused = () => new ApiError(403, 'forbidden', 'The server said no.')

function Harness({ load }: { load: () => Promise<string> }) {
  const query = useQuery({ queryKey: ['harness'], queryFn: load, meta: { silent: true } })
  return (
    <QueryState query={query} loading={<p>Loading…</p>} errorTitle="The list did not load">
      {data => <p>Got {data}</p>}
    </QueryState>
  )
}

describe('QueryState', () => {
  it('shows its skeleton, then the failure with a retry, then the answer the retry brings', async () => {
    let answer!: (value: string) => void
    const load = vi.fn<() => Promise<string>>()
      .mockRejectedValueOnce(refused())
      .mockImplementationOnce(() => new Promise(resolve => { answer = resolve }))
    renderWithApp(<Harness load={load} />)
    expect(screen.getByText('Loading…')).toBeInTheDocument()

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('The list did not load')
    expect(alert).toHaveTextContent('The server said no.')
    expect(screen.queryByText('Loading…')).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    // While the retry is out, the skeleton is back: the screen is waiting again, for something that can come.
    expect(await screen.findByText('Loading…')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(load).toHaveBeenCalledTimes(2)

    answer('three songs')
    expect(await screen.findByText('Got three songs')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('keeps the last answer when a later refetch fails', async () => {
    const load = vi.fn<() => Promise<string>>().mockResolvedValueOnce('one song').mockRejectedValue(refused())
    const { queryClient } = renderWithApp(<Harness load={load} />)
    expect(await screen.findByText('Got one song')).toBeInTheDocument()
    await queryClient.refetchQueries({ queryKey: ['harness'] })
    expect(load).toHaveBeenCalledTimes(2)
    expect(screen.getByText('Got one song')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('LoadError', () => {
  it('titles a whole page with a top-level heading', () => {
    renderWithApp(<LoadError variant="page" title="This page did not load" onRetry={() => {}} />)
    expect(screen.getByRole('heading', { level: 1, name: 'This page did not load' })).toBeInTheDocument()
  })
})
