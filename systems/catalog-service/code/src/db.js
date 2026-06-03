const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/imagibricks_catalog';
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

function normalizeProductRow(row) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    published: row.published,
    categories: row.categories || [],
    images: row.images || [],
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

  await pool.query(
    `INSERT INTO products (id, slug, name, description, published, categories, images, metadata)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb)`,
    [
      'prod-001',
      'brick-builder-set',
      'Brick Builder Set',
      'A premium starter set for creative builders.',
      true,
      JSON.stringify(['starter', 'creative']),
      JSON.stringify(['/images/brick-builder.jpg']),
      JSON.stringify({ weight: '1.5kg', brand: 'ImagiBricks' })
    ]
  );

  await pool.query(
    `INSERT INTO variants (id, product_id, sku, price, currency, inventory_item_id, attributes)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      'sku-001',
      'prod-001',
      'IB-SET-001',
      '39.99',
      'USD',
      'inv-001',
      JSON.stringify({ color: 'multicolor' })
    ]
  );
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
  normalizeProductRow,
  normalizeVariantRow
};
