const express = require('express');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 4001;

app.use(express.json());

function attachVariants(products, variants) {
  const variantMap = variants.reduce((acc, variant) => {
    if (!acc[variant.product_id]) acc[variant.product_id] = [];
    acc[variant.product_id].push(variant);
    return acc;
  }, {});

  return products.map((product) => ({
    ...product,
    variants: (variantMap[product.id] || []).map(db.normalizeVariantRow)
  }));
}

app.get('/catalog/products', async (req, res) => {
  try {
    const { published, category, search } = req.query;
    const conditions = [];
    const params = [];

    if (published === 'true' || published === 'false') {
      conditions.push(`published = $${params.length + 1}`);
      params.push(published === 'true');
    } else {
      conditions.push(`published = $${params.length + 1}`);
      params.push(true);
    }

    if (category) {
      conditions.push(`categories ? $${params.length + 1}`);
      params.push(category);
    }

    if (search) {
      conditions.push(`(name ILIKE $${params.length + 1} OR description ILIKE $${params.length + 1})`);
      params.push(`%${search}%`);
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const productsResult = await db.query(`SELECT * FROM products ${whereClause} ORDER BY name`, params);
    const productRows = productsResult.rows.map(db.normalizeProductRow);

    if (!productRows.length) {
      return res.json([]);
    }

    const variantsResult = await db.query(
      'SELECT * FROM variants WHERE product_id = ANY($1) ORDER BY sku',
      [productRows.map((product) => product.id)]
    );

    res.json(attachVariants(productRows, variantsResult.rows));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to load products' });
  }
});

app.get('/catalog/products/:id', async (req, res) => {
  try {
    const productResult = await db.query('SELECT * FROM products WHERE id = $1', [req.params.id]);
    if (!productResult.rows.length) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const product = db.normalizeProductRow(productResult.rows[0]);
    const variantsResult = await db.query('SELECT * FROM variants WHERE product_id = $1 ORDER BY sku', [product.id]);
    res.json({
      ...product,
      variants: variantsResult.rows.map(db.normalizeVariantRow)
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to load product' });
  }
});

app.get('/catalog/products/:id/availability', async (req, res) => {
  try {
    const productResult = await db.query('SELECT id FROM products WHERE id = $1', [req.params.id]);
    if (!productResult.rows.length) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const variantRows = await db.query('SELECT id AS sku_id FROM variants WHERE product_id = $1 ORDER BY sku_id', [req.params.id]);
    res.json({
      productId: req.params.id,
      available: variantRows.rows.length > 0,
      variants: variantRows.rows.map((variant) => ({ sku_id: variant.sku_id, available_quantity: null }))
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to load availability' });
  }
});

async function start() {
  try {
    await db.init();
    app.listen(PORT, () => {
      console.log(`catalog-service listening on port ${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start catalog-service:', error);
    process.exit(1);
  }
}

start();
