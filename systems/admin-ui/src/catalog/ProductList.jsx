import { useEffect, useState, useCallback } from 'react'
import { Link } from 'react-router-dom'
import mockApi from '../data/mockApi.js'
import Card from '../ui/Card.jsx'
import Pill from '../ui/Pill.jsx'
import Button from '../ui/Button.jsx'
import { useToast } from '../ui/toast.jsx'

const PAGE_SIZE = 20

export default function ProductList() {
  const toast = useToast()
  const [data, setData] = useState({ items: [], total: 0 })
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('')
  const [sort, setSort] = useState('name_asc')
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState(new Set())

  const load = useCallback(() => {
    mockApi.listProducts({ search, status, sort, page, limit: PAGE_SIZE }).then(setData)
  }, [search, status, sort, page])

  useEffect(() => { load() }, [load])

  const toggle = (id) => setSelected((s) => {
    const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n
  })

  const bulkPublish = async (newStatus) => {
    await mockApi.bulkSetStatus([...selected], newStatus)
    toast.push(`${selected.size} product(s) ${newStatus}`)
    setSelected(new Set())
    load()
  }

  const totalPages = Math.max(1, Math.ceil(data.total / PAGE_SIZE))

  return (
    <div>
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-3xl font-bold">Products</h1>
          <p className="text-gray-500">{data.total} total</p>
        </div>
        <Link to="/products/new"><Button>+ New product</Button></Link>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1) }}
          placeholder="Search by name…" className="rounded-pill border border-gray-200 px-4 py-2 text-sm" />
        <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1) }}
          className="rounded-pill border border-gray-200 px-4 py-2 text-sm">
          <option value="">All statuses</option>
          <option value="draft">Draft</option>
          <option value="published">Published</option>
          <option value="archived">Archived</option>
        </select>
        <select value={sort} onChange={(e) => setSort(e.target.value)}
          className="rounded-pill border border-gray-200 px-4 py-2 text-sm">
          <option value="name_asc">Name A–Z</option>
          <option value="name_desc">Name Z–A</option>
          <option value="updated_desc">Recently modified</option>
        </select>
        {selected.size > 0 && (
          <div className="ml-auto flex gap-2">
            <Button variant="brand" onClick={() => bulkPublish('published')}>Publish ({selected.size})</Button>
            <Button variant="ghost" onClick={() => bulkPublish('draft')}>Unpublish</Button>
          </div>
        )}
      </div>

      <Card className="mt-4 p-0 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left text-gray-500">
            <tr>
              <th className="w-10 p-3"></th>
              <th className="p-3">Name</th>
              <th className="p-3">Variants</th>
              <th className="p-3">Status</th>
              <th className="p-3">Last modified</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((p) => (
              <tr key={p.id} className="border-t border-gray-100">
                <td className="p-3"><input type="checkbox" checked={selected.has(p.id)} onChange={() => toggle(p.id)} /></td>
                <td className="p-3"><Link to={`/products/${p.id}`} className="font-semibold hover:underline">{p.name}</Link></td>
                <td className="p-3">{p.variant_count}</td>
                <td className="p-3"><Pill tone={p.status}>{p.status}</Pill></td>
                <td className="p-3 text-gray-500">{new Date(p.updated_at).toLocaleDateString()}</td>
              </tr>
            ))}
            {data.items.length === 0 && (
              <tr><td colSpan={5} className="p-8 text-center text-gray-400">No products match.</td></tr>
            )}
          </tbody>
        </table>
      </Card>

      <div className="mt-4 flex items-center justify-end gap-2 text-sm">
        <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="rounded-pill px-3 py-1 disabled:opacity-40">Prev</button>
        <span>Page {page} / {totalPages}</span>
        <button disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)} className="rounded-pill px-3 py-1 disabled:opacity-40">Next</button>
      </div>
    </div>
  )
}
