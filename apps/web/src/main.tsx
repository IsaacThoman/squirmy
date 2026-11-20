import { QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import { createQueryClient } from '@/api/query-client'
import { createServices, ServicesContext } from '@/api/services'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Toaster } from '@/components/ui/toast'
import { EngineProvider } from '@/player/engine/EngineProvider'
import { AppRoutes } from './App'
import './index.css'

const queryClient = createQueryClient()
const services = createServices()

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
