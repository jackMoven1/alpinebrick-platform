import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import api from '../data/api.js'
import Card from '../ui/Card.jsx'
import Pill from '../ui/Pill.jsx'
import InfoTab from './tabs/InfoTab.jsx'
import VariantsTab from './tabs/VariantsTab.jsx'
import ImagesTab from './tabs/ImagesTab.jsx'
import PublishTab from './tabs/PublishTab.jsx'

const TABS = ['Info', 'Variants', 'Images', 'Publish']

export default function ProductDetail() {
  const { id } = useParams()
  const [product, setProduct] = useState(null)
  const [tab, setTab] = useState('Info')
  const [error, setError] = useState(null)
  const [infoDirty, setInfoDirty] = useState(false)

  useEffect(() => {
    api.getProduct(id).then(setProduct).catch((e) => setError(e.message))
  }, [id])

  // spec §6: leaving Info with unsaved edits asks first — switching tabs is
  // one more way to "leave" besides closing the browser tab, which InfoTab's
  // own beforeunload guard already covers.
  const selectTab = (t) => {
    if (t !== tab && infoDirty && !window.confirm('Discard unsaved changes to this product?')) return
    setTab(t)
  }

  if (error) return <p className="text-accent">{error}</p>
  if (!product) return <p className="text-gray-400">Loading…</p>

  return (
    <div className="max-w-3xl">
      <Link to="/products" className="text-sm text-gray-500">← Products</Link>
      <div className="mt-2 flex items-center gap-3">
        <h1 className="text-3xl font-bold">{product.name}</h1>
        <Pill tone={product.status}>{product.status}</Pill>
      </div>

      <div className="mt-4 flex gap-1">
        {TABS.map((t) => (
          <button key={t} onClick={() => selectTab(t)}
            className={`rounded-pill px-4 py-2 text-sm font-semibold ${tab === t ? 'bg-ink text-white' : 'text-gray-600 hover:bg-white'}`}>
            {t}
          </button>
        ))}
      </div>

      <Card className="mt-4">
        {tab === 'Info' && <InfoTab product={product} onUpdated={setProduct} onDirtyChange={setInfoDirty} />}
        {tab === 'Variants' && <VariantsTab product={product} onUpdated={setProduct} />}
        {/* Keyed by product id: ImagesTab tracks its own in-flight uploads/refreshes
            (see its file header) and must fully remount — not just re-render with a
            new `product` prop — when the operator navigates to a different product,
            so no stale upload row from the previous product lingers on screen. */}
        {tab === 'Images' && <ImagesTab key={product.id} product={product} onUpdated={setProduct} />}
        {tab === 'Publish' && <PublishTab product={product} onUpdated={setProduct} />}
      </Card>
    </div>
  )
}
