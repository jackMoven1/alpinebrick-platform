const http = require('http');

// Mock the db layer so tests run without Postgres. We keep the real
// normalize* helpers (they are pure) but stub query() with a small fake
// engine that understands the queries index.js issues.
jest.mock('../src/db', () => {
  const actual = jest.requireActual('../src/db');

  const products = [
    {
      id: 'prod-001',
      slug: 'brick-builder-set',
      name: 'Brick Builder Set',
      description: 'A premium starter set for creative builders.',
      published: true,
      categories: ['starter', 'creative'],
      images: [{ url: '/images/brick-builder.jpg', alt: 'Brick Builder Set box' }],
      metadata: { brand: 'Alpine Brick Exchange' },
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      min_price: 39.99
    },
    {
      id: 'prod-002',
      slug: 'castle-mega-pack',
      name: 'Castle Mega Pack',
      description: 'An advanced medieval castle build.',
      published: true,
      categories: ['advanced', 'creative'],
      images: [{ url: '/images/castle.jpg', alt: 'Assembled castle' }],
      metadata: { brand: 'Alpine Brick Exchange' },
      created_at: '2026-02-01T00:00:00Z',
      updated_at: '2026-02-01T00:00:00Z',
      min_price: 89.99
    }
  ];

  const variants = [
    { id: 'sku-001', product_id: 'prod-001', sku: 'IB-SET-001', price: '39.99', currency: 'USD', inventory_item_id: 'inv-001', attributes: {} },
    { id: 'sku-002', product_id: 'prod-002', sku: 'IB-CASTLE-001', price: '89.99', currency: 'USD', inventory_item_id: 'inv-002', attributes: {} }
  ];

  function query(text, params = []) {
    // COUNT for the list envelope
    if (/SELECT COUNT\(\*\)/.test(text)) {
      return Promise.resolve({ rows: [{ total: products.length }] });
    }
    // Paged product list: honor ORDER BY (price_*/newest/name) + LIMIT/OFFSET
    if (/FROM products p/.test(text) && /LIMIT/.test(text)) {
      let rows = [...products];
      if (/min_price DESC/.test(text)) rows.sort((a, b) => b.min_price - a.min_price);
      else if (/min_price ASC/.test(text)) rows.sort((a, b) => a.min_price - b.min_price);
      else if (/created_at DESC/.test(text)) rows.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
      else rows.sort((a, b) => a.name.localeCompare(b.name));
      const limit = params[params.length - 2];
      const offset = params[params.length - 1];
      return Promise.resolve({ rows: rows.slice(offset, offset + limit) });
    }
    // Single product by id
    if (/SELECT \* FROM products WHERE id = \$1/.test(text)) {
      const row = products.find((p) => p.id === params[0]);
      return Promise.resolve({ rows: row ? [row] : [] });
    }
    // Availability existence check
    if (/SELECT id FROM products WHERE id = \$1/.test(text)) {
      const row = products.find((p) => p.id === params[0]);
      return Promise.resolve({ rows: row ? [{ id: row.id }] : [] });
    }
    // Variants for availability (aliased sku_id)
    if (/SELECT id AS sku_id FROM variants/.test(text)) {
      const rows = variants.filter((v) => v.product_id === params[0]).map((v) => ({ sku_id: v.id }));
      return Promise.resolve({ rows });
    }
    // Variants by ANY(product ids) or single product_id
    if (/FROM variants WHERE product_id = ANY/.test(text)) {
      const ids = params[0];
      return Promise.resolve({ rows: variants.filter((v) => ids.includes(v.product_id)) });
    }
    if (/FROM variants WHERE product_id = \$1/.test(text)) {
      return Promise.resolve({ rows: variants.filter((v) => v.product_id === params[0]) });
    }
    return Promise.resolve({ rows: [] });
  }

  return {
    ...actual,
    query,
    init: jest.fn().mockResolvedValue(undefined)
  };
});

const { app } = require('../src/index');

let server;
let baseUrl;

beforeAll((done) => {
  server = app.listen(0, () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});

afterAll((done) => {
  server.close(done);
});

function request(path) {
  return new Promise((resolve, reject) => {
    http
      .get(`${baseUrl}${path}`, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          let body;
          try {
            body = data ? JSON.parse(data) : null;
          } catch (e) {
            return reject(new Error(`Bad JSON: ${data}`));
          }
          resolve({ status: res.statusCode, body });
        });
      })
      .on('error', reject);
  });
}

describe('GET /api/v1/catalog/products — pagination envelope', () => {
  test('returns the {items,total,page,limit} envelope, not a bare array', async () => {
    const { status, body } = await request('/api/v1/catalog/products');
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(false);
    expect(body).toHaveProperty('items');
    expect(Array.isArray(body.items)).toBe(true);
    expect(body).toMatchObject({ total: 2, page: 1, limit: 24 });
  });

  test('total reflects full unpaginated count even when limit slices results', async () => {
    const { body } = await request('/api/v1/catalog/products?limit=1&page=1');
    expect(body.total).toBe(2);
    expect(body.limit).toBe(1);
    expect(body.items).toHaveLength(1);
  });

  test('page 2 with limit 1 returns the second item', async () => {
    const p1 = await request('/api/v1/catalog/products?limit=1&page=1');
    const p2 = await request('/api/v1/catalog/products?limit=1&page=2');
    expect(p2.body.page).toBe(2);
    expect(p2.body.items[0].id).not.toBe(p1.body.items[0].id);
  });

  test('images are {url, alt} objects with the first as primary', async () => {
    const { body } = await request('/api/v1/catalog/products');
    const img = body.items[0].images[0];
    expect(img).toHaveProperty('url');
    expect(img).toHaveProperty('alt');
    expect(typeof img.alt).toBe('string');
  });
});

describe('GET /api/v1/catalog/products — sort', () => {
  test('price_asc orders by cheapest variant first', async () => {
    const { body } = await request('/api/v1/catalog/products?sort=price_asc');
    expect(body.items[0].id).toBe('prod-001');
  });

  test('price_desc orders by most expensive first', async () => {
    const { body } = await request('/api/v1/catalog/products?sort=price_desc');
    expect(body.items[0].id).toBe('prod-002');
  });

  test('newest orders by created_at desc', async () => {
    const { body } = await request('/api/v1/catalog/products?sort=newest');
    expect(body.items[0].id).toBe('prod-002');
  });
});

describe('GET /api/v1/catalog/products — validation errors', () => {
  test('bad page returns 400 with {code,message,fields}', async () => {
    const { status, body } = await request('/api/v1/catalog/products?page=0');
    expect(status).toBe(400);
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(typeof body.message).toBe('string');
    expect(body.fields).toHaveProperty('page');
  });

  test('limit over max returns 400', async () => {
    const { status, body } = await request('/api/v1/catalog/products?limit=101');
    expect(status).toBe(400);
    expect(body.fields).toHaveProperty('limit');
  });

  test('unknown sort returns 400', async () => {
    const { status, body } = await request('/api/v1/catalog/products?sort=bogus');
    expect(status).toBe(400);
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.fields).toHaveProperty('sort');
  });
});

describe('detail + availability endpoints', () => {
  test('by-id returns a single product object (no envelope)', async () => {
    const { status, body } = await request('/api/v1/catalog/products/prod-001');
    expect(status).toBe(200);
    expect(body.id).toBe('prod-001');
    expect(body).not.toHaveProperty('items');
    expect(body.variants).toHaveLength(1);
  });

  test('by-id 404 uses NOT_FOUND error shape', async () => {
    const { status, body } = await request('/api/v1/catalog/products/missing');
    expect(status).toBe(404);
    expect(body.code).toBe('NOT_FOUND');
    expect(body).not.toHaveProperty('error');
  });

  test('availability uses product_id (snake_case) and null available_quantity', async () => {
    const { status, body } = await request('/api/v1/catalog/products/prod-001/availability');
    expect(status).toBe(200);
    expect(body).toHaveProperty('product_id', 'prod-001');
    expect(body).not.toHaveProperty('productId');
    expect(body.variants[0].available_quantity).toBeNull();
  });

  test('availability 404 uses NOT_FOUND error shape', async () => {
    const { status, body } = await request('/api/v1/catalog/products/missing/availability');
    expect(status).toBe(404);
    expect(body.code).toBe('NOT_FOUND');
  });
});
