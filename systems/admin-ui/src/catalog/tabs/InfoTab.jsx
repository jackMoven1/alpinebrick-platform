/**
 * Read-only in the Phase B slice.
 *
 * updateProduct has no endpoint in core yet. The fields are rendered so the
 * data is visible, but they are readOnly and there is no auto-save: an edit
 * that appeared to save and vanished on reload would be data loss disguised
 * as success.
 */
export default function InfoTab({ product }) {
  const categories = (product.categories || []).join(', ')

  return (
    <div className="space-y-4">
      <div className="rounded-xl bg-gray-100 px-4 py-3 text-sm text-gray-600">
        Editing is not in this phase — this view is read-only.
      </div>
      <label className="block">
        <span className="text-sm font-semibold">Name</span>
        <input value={product.name} readOnly
          className="mt-1 w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-gray-600" />
      </label>
      <label className="block">
        <span className="text-sm font-semibold">Description</span>
        <textarea value={product.description} readOnly rows={4}
          className="mt-1 w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-gray-600" />
      </label>
      <label className="block">
        <span className="text-sm font-semibold">Categories</span>
        <input value={categories} readOnly
          className="mt-1 w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-gray-600" />
      </label>
    </div>
  )
}
