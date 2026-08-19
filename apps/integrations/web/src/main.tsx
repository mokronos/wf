import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { BrowserRouter } from "react-router"

import App from "@/App"
import { TooltipProvider } from "@/components/ui/tooltip"

import "@/index.css"

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // The gateway is on loopback, so a refetch costs nothing and a stale
      // permission on screen costs a lot.
      staleTime: 5_000,
      retry: false,
      refetchOnWindowFocus: true
    }
  }
})

const container = document.getElementById("root")
if (container === null) throw new Error("index.html is missing its #root element")

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <TooltipProvider>
          <App />
        </TooltipProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>
)
