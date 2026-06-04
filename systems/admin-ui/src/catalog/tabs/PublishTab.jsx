import mockApi from '../../data/mockApi.js'
import Pill from '../../ui/Pill.jsx'
import Button from '../../ui/Button.jsx'
import { useToast } from '../../ui/toast.jsx'

export default function PublishTab({ product, onUpdated }) {
  const toast = useToast()
  const warnings = []
  if (product.variants.length === 0) warnings.push('No variants')
  if (product.images.length === 0) warnings.push('No images')
  if (!product.description) warnings.push('No description')

  const setStatus = async (status) => {
    const updated = await mockApi.setProductStatus(product.id, status)
    onUpdated(updated)
    toast.push(`Status: ${status}`)
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <span className="text-sm font-semibold">Current status:</span>
        <Pill tone={product.status}>{product.status}</Pill>
      </div>
      {warnings.length > 0 && (
        <div className="rounded-xl bg-accent-soft px-4 py-3 text-sm text-accent">
          Warnings (publish still allowed): {warnings.join(', ')}.
        </div>
      )}
      <div className="flex gap-2">
        <Button variant="brand" onClick={() => setStatus('published')} disabled={product.status === 'published'}>Publish</Button>
        <Button variant="ghost" onClick={() => setStatus('draft')} disabled={product.status === 'draft'}>Set to draft</Button>
        <Button variant="danger" onClick={() => setStatus('archived')} disabled={product.status === 'archived'}>Archive</Button>
      </div>
    </div>
  )
}
