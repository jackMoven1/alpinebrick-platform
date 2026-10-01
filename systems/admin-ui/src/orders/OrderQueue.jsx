import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import api from '../data/api.js'
import Pill from '../ui/Pill.jsx'
import { formatCents } from '../lib/money.js'
import { errorText } from '../lib/errorText.js'
import { ORDER_TABS, REVIEW_LABELS, STATUS_LABELS } from './labels.js'

const PAGE_SIZE = 25
const day = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

export default function OrderQueue() {
  const [params, setParams] = useSearchParams()
  const tab = ORDER_TABS.some((t) => t.id === params.get('tab')) ? params.get('tab') : 'to_ship'
  const page = Math.max(1, Number(params.get('page')) || 1)
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let live = true
    setData(null)
    setError(null)
    api.listOrders({ tab, page, pageSize: PAGE_SIZE })
      .then((d) => { if (live) setData(d) })
      .catch((e) => { if (live) setError(errorText(e)) })
    return () => { live = false }
  }, [tab, page])

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1

  // A tab switch, or another admin clearing the last item on this page,
  // can leave `page` past the end (e.g. the URL still says page=3 after the
  // last order on it ships). Clamp back onto the real last page rather than
  // showing an empty table with "Next" disabled and no way back.
  useEffect(() => {
    if (data && page > totalPages) setParams({ tab, page: String(totalPages) })
  }, [data, totalPages, page, tab, setParams])

  return (
    <div>
      <h1 className="text-3xl font-bold">Orders</h1>
      <p className="text-gray-500">Storefront orders. Refunds are issued in the Stripe dashboard.</p>

      <div role="tablist" aria-label="Order queues" className="mt-4 flex flex-wrap gap-2">
        {ORDER_TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={t.id === tab} onClick={() => setParams({ tab: t.id })}
            className={`rounded-pill px-4 py-2 text-sm font-semibold ${t.id === tab ? 'bg-ink text-white' : 'bg-white text-gray-600'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {error && <p role="alert" className="mt-4 text-sm text-accent">{error}</p>}
      {!data && !error && <p className="mt-4 text-sm text-gray-500">Loading…</p>}
      {data && (
        <>
          <table className="mt-4 w-full text-sm">
            <thead className="text-left text-gray-500">
              <tr><th className="py-2">Order</th><th>Date</th><th>Customer</th><th>Items</th><th>Total</th><th>Ship to</th><th>Status</th><th></th></tr>
            </thead>
            <tbody>
              {data.items.map((o) => (
                <tr key={o.id} className="border-t border-gray-100">
                  <td className="py-2"><Link to={`/orders/${o.id}`} className="font-semibold">{o.orderNumber}</Link></td>
                  <td>{day(o.createdAt)}</td>
                  <td>{o.email ?? '—'}</td>
                  <td>{o.itemCount}</td>
                  <td>{formatCents(o.totalCents)}</td>
                  <td>{o.shipToState ?? '—'}</td>
                  {/* Needs review mixes every status (pending/paid/fulfilled...),
                      so the row needs its own status, not just the review reason. */}
                  <td><Pill>{STATUS_LABELS[o.status] ?? o.status}</Pill></td>
                  <td>{o.reviewReason && <Pill>{REVIEW_LABELS[o.reviewReason] ?? o.reviewReason}</Pill>}</td>
                </tr>
              ))}
              {data.items.length === 0 && <tr><td colSpan={8} className="py-4 text-gray-400">No orders here.</td></tr>}
            </tbody>
          </table>
          <div className="mt-4 flex items-center gap-3 text-sm">
            <button disabled={page <= 1} onClick={() => setParams({ tab, page: String(page - 1) })} className="disabled:text-gray-300">Previous</button>
            <span>Page {page} of {totalPages}</span>
            <button disabled={page >= totalPages} onClick={() => setParams({ tab, page: String(page + 1) })} className="disabled:text-gray-300">Next</button>
          </div>
        </>
      )}
    </div>
  )
}
