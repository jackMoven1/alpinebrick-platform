const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/alpinebrick_catalog';
const pool = new Pool({ connectionString });

async function waitForDatabase(retries = 8, intervalMs = 2000) {
  while (retries > 0) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (error) {
      retries -= 1;
      if (retries <= 0) {
        throw error;
      }
      console.warn(`Postgres not ready, retrying in ${intervalMs}ms... (${retries} attempts left)`);
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
}

function normalizeImage(image) {
  // v1 images are { url, alt } objects. Tolerate legacy bare strings from
  // any un-reseeded dev DB by coercing them into the object shape so the
  // contract surface is always { url, alt }.
  if (typeof image === 'string') {
    return { url: image, alt: '' };
  }
  return { url: image.url, alt: image.alt || '' };
}

function normalizeProductRow(row) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    published: row.published,
    categories: row.categories || [],
    images: (row.images || []).map(normalizeImage),
    metadata: row.metadata || {},
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function normalizeVariantRow(row) {
  return {
    id: row.id,
    product_id: row.product_id,
    sku: row.sku,
    price: Number(row.price),
    currency: row.currency,
    inventory_item_id: row.inventory_item_id,
    attributes: row.attributes || {},
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

async function setupSchema() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      CREATE TABLE IF NOT EXISTS products (
        id TEXT PRIMARY KEY,
        slug TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        published BOOLEAN NOT NULL DEFAULT FALSE,
        categories JSONB NOT NULL DEFAULT '[]'::jsonb,
        images JSONB NOT NULL DEFAULT '[]'::jsonb,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS variants (
        id TEXT PRIMARY KEY,
        product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        sku TEXT UNIQUE NOT NULL,
        price NUMERIC(12,2) NOT NULL,
        currency TEXT NOT NULL DEFAULT 'USD',
        inventory_item_id TEXT,
        attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_products_published ON products(published);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_variants_product_id ON variants(product_id);`);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function seedInitialData() {
  const result = await pool.query('SELECT 1 FROM products LIMIT 1');
  if (result.rowCount > 0) {
    return;
  }

  const seedProducts = [
    {
      id: 'prod-001',
      slug: 'brick-builder-set',
      name: 'Brick Builder Set',
      description: 'A premium starter set for creative builders.',
      published: true,
      categories: ['starter', 'creative'],
      images: [
        { url: '/images/brick-builder.jpg', alt: 'Brick Builder Set in its retail box' }
      ],
      metadata: { weight: '1.5kg', brand: 'Alpine Brick Exchange' }
    },
    {
      id: 'prod-002',
      slug: 'castle-mega-pack',
      name: 'Castle Mega Pack',
      description: 'An advanced medieval castle build with movable parts.',
      published: true,
      categories: ['advanced', 'creative'],
      images: [
        { url: '/images/castle-mega.jpg', alt: 'Assembled medieval castle with towers' },
        { url: '/images/castle-mega-parts.jpg', alt: 'Castle Mega Pack loose pieces laid out' }
      ],
      metadata: { weight: '3.2kg', brand: 'Alpine Brick Exchange' }
    }
  ];

  for (const product of seedProducts) {
    await pool.query(
      `INSERT INTO products (id, slug, name, description, published, categories, images, metadata)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb)`,
      [
        product.id,
        product.slug,
        product.name,
        product.description,
        product.published,
        JSON.stringify(product.categories),
        JSON.stringify(product.images),
        JSON.stringify(product.metadata)
      ]
    );
  }

  const seedVariants = [
    {
      id: 'sku-001',
      product_id: 'prod-001',
      sku: 'IB-SET-001',
      price: '39.99',
      currency: 'USD',
      inventory_item_id: 'inv-001',
      attributes: { color: 'multicolor' }
    },
    {
      id: 'sku-002',
      product_id: 'prod-002',
      sku: 'IB-CASTLE-001',
      price: '89.99',
      currency: 'USD',
      inventory_item_id: 'inv-002',
      attributes: { color: 'grey' }
    }
  ];

  for (const variant of seedVariants) {
    await pool.query(
      `INSERT INTO variants (id, product_id, sku, price, currency, inventory_item_id, attributes)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [
        variant.id,
        variant.product_id,
        variant.sku,
        variant.price,
        variant.currency,
        variant.inventory_item_id,
        JSON.stringify(variant.attributes)
      ]
    );
  }
}

async function init() {
  await waitForDatabase();
  await setupSchema();
  await seedInitialData();
}

module.exports = {
  pool,
  query: (text, params) => pool.query(text, params),
  init,
  normalizeImage,
  normalizeProductRow,
  normalizeVariantRow
};
