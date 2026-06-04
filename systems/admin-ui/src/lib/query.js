const SORTERS = {
  name_asc: (a, b) => a.name.localeCompare(b.name),
  name_desc: (a, b) => b.name.localeCompare(a.name),
  updated_desc: (a, b) => String(b.updated_at).localeCompare(String(a.updated_at)),
  updated_asc: (a, b) => String(a.updated_at).localeCompare(String(b.updated_at)),
}

export function applyQuery(items, opts = {}) {
  const { search = '', category = '', status = '', sort = 'name_asc', page = 1, limit = 20 } = opts
  let rows = [...items]
  if (search) {
    const q = search.toLowerCase()
    rows = rows.filter((r) => r.name.toLowerCase().includes(q))
  }
  if (status) rows = rows.filter((r) => r.status === status)
  if (category) rows = rows.filter((r) => (r.categories || []).includes(category))
  rows.sort(SORTERS[sort] || SORTERS.name_asc)
  const total = rows.length
  const start = (page - 1) * limit
  return { items: rows.slice(start, start + limit), total, page, limit }
}
