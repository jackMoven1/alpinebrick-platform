import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import mockApi from '../data/mockApi.js'
import Card from '../ui/Card.jsx'
import StatCard from '../ui/StatCard.jsx'
import Pill from '../ui/Pill.jsx'
import Button from '../ui/Button.jsx'

export default function CatalogOverview() {
  const [stats, setStats] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    mockApi.getOverviewStats().then(setStats).catch((e) => setError(e.message))
  }, [])

  if (error) return <p className="text-accent">{error}</p>
  if (!stats) return <p className="text-gray-400">Loading…</p>

  return (
    <div>
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-3xl font-bold">Catalog</h1>
          <p className="text-gray-500">Manage your product catalog.</p>
        </div>
        <Link to="/products/new"><Button>+ New product</Button></Link>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Total products" value={stats.totalProducts} />
        <StatCard label="Published" value={stats.published} />
        <StatCard label="Drafts" value={stats.draft} />
        <StatCard label="Archived" value={stats.archived} />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card>
          <div className="flex items-center justify-between">
            <h2 className="font-bold">Recently modified</h2>
            <Link to="/products" className="text-sm text-brand-dark">See all</Link>
          </div>
          <ul className="mt-3 space-y-2">
            {stats.recentlyModified.map((p) => (
              <li key={p.id} className="flex items-center justify-between text-sm">
                <Link to={`/products/${p.id}`} className="hover:underline">{p.name}</Link>
                <Pill tone={p.status}>{p.status}</Pill>
              </li>
            ))}
          </ul>
        </Card>
        <Card>
          <h2 className="font-bold">Missing images</h2>
          <ul className="mt-3 space-y-2 text-sm">
            {stats.missingImages.length === 0 && <li className="text-gray-400">None 🎉</li>}
            {stats.missingImages.map((p) => (
              <li key={p.id}><Link to={`/products/${p.id}`} className="hover:underline">{p.name}</Link></li>
            ))}
          </ul>
        </Card>
        <Card>
          <h2 className="font-bold">Missing variants</h2>
          <ul className="mt-3 space-y-2 text-sm">
            {stats.missingVariants.length === 0 && <li className="text-gray-400">None 🎉</li>}
            {stats.missingVariants.map((p) => (
              <li key={p.id}><Link to={`/products/${p.id}`} className="hover:underline">{p.name}</Link></li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  )
}
