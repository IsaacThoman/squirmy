import { render } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router'
import { TooltipProvider } from '@/components/ui/tooltip'
import { FixtureProviders } from '@/fixtures/FixtureProviders'

/** Renders inside the router, tooltips and the fixture session, like the app. */
export function renderWithApp(ui: ReactElement, route = '/') {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <TooltipProvider>
        <FixtureProviders>{ui}</FixtureProviders>
      </TooltipProvider>
    </MemoryRouter>,
  )
}
