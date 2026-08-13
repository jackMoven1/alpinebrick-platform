import { createBrowserRouter } from 'react-router'

// Placeholder route table. Task 10 replaces this with the full shell and the
// complete route set from the design handoff.
export const router = createBrowserRouter([
  {
    path: '/',
    element: (
      <main className="min-h-screen bg-background text-foreground grid place-items-center">
        <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
          Alpine Brick Exchange — storefront scaffold
        </p>
      </main>
    ),
  },
])
