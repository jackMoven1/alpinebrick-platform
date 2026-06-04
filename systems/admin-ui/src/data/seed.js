export function makeSeed() {
  return [
    {
      id: 'prod-001', name: 'Classic Brick Set', slug: 'classic-brick-set',
      description: 'A timeless 500-piece building set.', categories: ['sets', 'classic'],
      metadata: { brand: 'ImagiBricks', weight: '1.2kg' },
      status: 'published', published_at: '2026-05-20T12:00:00.000Z', archived_at: null,
      created_at: '2026-05-01T10:00:00.000Z', updated_at: '2026-05-20T12:00:00.000Z',
      created_by: 'admin-1', updated_by: 'admin-1',
      variants: [
        { id: 'var-001', product_id: 'prod-001', sku: 'CBS-STD', price: 49.99, inventory_item_id: null, attributes: {} },
      ],
      images: [
        { id: 'img-001', product_id: 'prod-001', url: 'https://placehold.co/600x400/7B5CFA/fff?text=Classic', alt_text: 'Classic Brick Set box', display_order: 0 },
      ],
    },
    {
      id: 'prod-002', name: 'Space Rover Kit', slug: 'space-rover-kit',
      description: '', categories: ['vehicles'],
      metadata: { brand: 'ImagiBricks' },
      status: 'draft', published_at: null, archived_at: null,
      created_at: '2026-05-28T09:00:00.000Z', updated_at: '2026-05-28T09:00:00.000Z',
      created_by: 'admin-1', updated_by: 'admin-1',
      variants: [],
      images: [],
    },
  ]
}
