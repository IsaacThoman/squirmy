import { QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import { restoreBeforeRender, startPersisting } from '@/api/persist'
import { homeQuery } from '@/api/queries'
import { createQueryClient } from '@/api/query-client'
import { createServices, ServicesContext } from '@/api/services'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Toaster } from '@/components/ui/toast'
import { startAppearance } from '@/lib/appearance'
import { claimTabDevice } from '@/lib/device'
import { EngineProvider } from '@/player/engine/EngineProvider'
import { AppRoutes } from './App'
import '@fontsource-variable/inter'
import './index.css'

startAppearance()
// The player waits for this tab's device; asked now, it is usually settled before the first
// render, which then does not stop at the splash screen.
void claimTabDevice()
const queryClient = createQueryClient()
const services = createServices()

// The last session's pages first, so a reload paints them before any request returns.
await restoreBeforeRender(queryClient, () => void queryClient.prefetchQuery(homeQuery(services.api)))
startPersisting(queryClient)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ServicesContext value={services}>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <TooltipProvider delayDuration={500} skipDelayDuration={200}>
            <EngineProvider>
              <AppRoutes />
              <Toaster />
            </EngineProvider>
          </TooltipProvider>
        </BrowserRouter>
      </QueryClientProvider>
    </ServicesContext>
  </StrictMode>,
)
