const products = [
  {
    id: 'prod-001',
    slug: 'brick-builder-set',
    name: 'Brick Builder Set',
    description: 'A premium starter set for creative builders.',
    published: true,
    categories: ['starter', 'creative'],
    images: ['/images/brick-builder.jpg'],
    metadata: {
      weight: '1.5kg',
      brand: 'Alpine Brick Exchange'
    },
    variants: [
      {
        id: 'sku-001',
        sku: 'IB-SET-001',
        price: 39.99,
        currency: 'USD',
        inventory_item_id: 'inv-001',
        attributes: {
          color: 'multicolor'
        }
      }
    ]
  }
];

function list() {
  return products;
}

function get(id) {
  return products.find((product) => product.id === id);
}

module.exports = { list, get };
