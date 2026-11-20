import { QueryClientProvider } from '@tanstack/react-query'
import { render } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router'
import { createQueryClient } from '@/api/query-client'
import { ServicesContext, type Services } from '@/api/services'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Toaster } from '@/components/ui/toast'
import { FixtureProviders } from '@/fixtures/FixtureProviders'
import { fakeServices } from './fake-services'

/** Renders inside the router, the query client, tooltips and the fixture session, like the app. */
export function renderWithApp(ui: ReactElement, route = '/', services: Services = fakeServices().services) {
  const queryClient = createQueryClient()
  const result = render(
    <ServicesContext value={services}>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[route]}>
          <TooltipProvider>
            <FixtureProviders>{ui}<Toaster /></FixtureProviders>
          </TooltipProvider>
        </MemoryRouter>
      </QueryClientProvider>
    </ServicesContext>,
  )
  return { ...result, queryClient }
}
