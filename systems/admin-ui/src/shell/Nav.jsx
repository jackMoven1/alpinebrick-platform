import { NavLink } from 'react-router-dom'

const sections = [
  { to: '/', label: 'Overview', end: true },
  { to: '/products', label: 'Products' },
]

export default function Nav() {
  return (
    <nav className="flex items-center gap-1">
      {sections.map((s) => (
        <NavLink key={s.to} to={s.to} end={s.end}
          className={({ isActive }) =>
            `rounded-pill px-4 py-2 text-sm font-semibold ${isActive ? 'bg-ink text-white' : 'text-gray-600 hover:bg-white'}`}>
          {s.label}
        </NavLink>
      ))}
    </nav>
  )
}
