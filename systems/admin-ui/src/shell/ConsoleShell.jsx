import { Outlet } from 'react-router-dom'
import Nav from './Nav.jsx'

export default function ConsoleShell() {
  return (
    <div className="min-h-screen">
      <header className="flex items-center justify-between px-8 py-4">
        <div className="flex items-center gap-6">
          <div className="flex h-9 w-9 items-center justify-center rounded-card bg-brand text-white font-bold">IB</div>
          <Nav />
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-gray-500">admin-1</span>
          <div className="h-9 w-9 rounded-pill bg-brand-soft" aria-label="admin avatar" />
        </div>
      </header>
      <main className="px-8 pb-12">
        <Outlet />
      </main>
    </div>
  )
}
