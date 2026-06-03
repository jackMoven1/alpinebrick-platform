const express = require('express');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 4001;

app.use(express.json());

const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 100;

// sort enum -> ORDER BY clause. price_* sorts on the product's minimum variant
// price (computed via a correlated subquery), so a product is ranked by its
// cheapest buyable variant. Documented in the OpenAPI `sort` description.
const SORT_CLAUSES = {
  name_asc: 'p.name ASC',
  price_asc: 'min_price ASC NULLS LAST, p.name ASC',
  price_desc: 'min_price DESC NULLS LAST, p.name ASC',
  newest: 'p.created_at DESC, p.name ASC'
};

function errorBody(code, message, fields) {
  const body = { code, message };
  if (fields) body.fields = fields;
  return body;
}

// Parse + validate page/limit. Returns { page, limit } or throws a tagged
// validation error consumed by the route handler.
function parsePagination(query) {
  const fields = {};
  let page = 1;
  let limit = DEFAULT_LIMIT;

  if (query.page !== undefined) {
    page = Number(query.page);
    if (!Number.isInteger(page) || page < 1) {
      fields.page = 'must be an integer >= 1';
    }
  }

  if (query.limit !== undefined) {
    limit = Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      fields.limit = `must be an integer between 1 and ${MAX_LIMIT}`;
    }
  }

  if (Object.keys(fields).length) {
    const err = new Error('Invalid pagination parameters');
    err.validation = fields;
    throw err;
  }

  return { page, limit };
}

// Validate sort against the frozen enum. Defaults to name_asc.
function parseSort(query) {
  const sort = query.sort === undefined ? 'name_asc' : query.sort;
  if (!Object.prototype.hasOwnProperty.call(SORT_CLAUSES, sort)) {
    const err = new Error('Invalid sort parameter');
    err.validation = { sort: `must be one of: ${Object.keys(SORT_CLAUSES).join(', ')}` };
    throw err;
  }
  return sort;
}

// Build WHERE conditions + params from the filter query. Returns
// { conditions: string[], params: any[] }.
function buildFilters(query) {
  const { published, category, search } = query;
  const conditions = [];
  const params = [];

  if (published === 'true' || published === 'false') {
    conditions.push(`p.published = $${params.length + 1}`);
    params.push(published === 'true');
  } else {
    conditions.push(`p.published = $${params.length + 1}`);
    params.push(true);
  }

  if (category) {
    conditions.push(`p.categories ? $${params.length + 1}`);
    params.push(category);
  }

  if (search) {
    conditions.push(
      `(p.name ILIKE $${params.length + 1} OR p.description ILIKE $${params.length + 1})`
    );
    params.push(`%${search}%`);
  }

  return { conditions, params };
}

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

app.get('/api/v1/catalog/products', async (req, res) => {
  let page;
  let limit;
  let sort;
  try {
    ({ page, limit } = parsePagination(req.query));
    sort = parseSort(req.query);
  } catch (error) {
    if (error.validation) {
      return res
        .status(400)
        .json(errorBody('VALIDATION_ERROR', error.message, error.validation));
    }
    throw error;
  }

  try {
    const { conditions, params } = buildFilters(req.query);
    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    // Full unpaginated count for the envelope.
    const countResult = await db.query(
      `SELECT COUNT(*)::int AS total FROM products p ${whereClause}`,
      params
    );
    const total = countResult.rows[0].total;

    const offset = (page - 1) * limit;
    const orderBy = SORT_CLAUSES[sort];
    const limitParam = `$${params.length + 1}`;
    const offsetParam = `$${params.length + 2}`;

    // min_price subquery powers price_* sorting by cheapest variant.
    const productsResult = await db.query(
      `SELECT p.*, (SELECT MIN(price) FROM variants v WHERE v.product_id = p.id) AS min_price
       FROM products p
       ${whereClause}
       ORDER BY ${orderBy}
       LIMIT ${limitParam} OFFSET ${offsetParam}`,
      [...params, limit, offset]
    );

    const productRows = productsResult.rows.map(db.normalizeProductRow);

    let items = [];
    if (productRows.length) {
      const variantsResult = await db.query(
        'SELECT * FROM variants WHERE product_id = ANY($1) ORDER BY sku',
        [productRows.map((product) => product.id)]
      );
      items = attachVariants(productRows, variantsResult.rows);
    }

    res.json({ items, total, page, limit });
  } catch (error) {
    console.error(error);
    res.status(500).json(errorBody('INTERNAL', 'Failed to load products'));
  }
});

app.get('/api/v1/catalog/products/:id', async (req, res) => {
  try {
    const productResult = await db.query('SELECT * FROM products WHERE id = $1', [req.params.id]);
    if (!productResult.rows.length) {
      return res.status(404).json(errorBody('NOT_FOUND', 'Product not found'));
    }

    const product = db.normalizeProductRow(productResult.rows[0]);
    const variantsResult = await db.query('SELECT * FROM variants WHERE product_id = $1 ORDER BY sku', [product.id]);
    res.json({
      ...product,
      variants: variantsResult.rows.map(db.normalizeVariantRow)
    });
  } catch (error) {
    console.error(error);
    res.status(500).json(errorBody('INTERNAL', 'Failed to load product'));
  }
});

app.get('/api/v1/catalog/products/:id/availability', async (req, res) => {
  try {
    const productResult = await db.query('SELECT id FROM products WHERE id = $1', [req.params.id]);
    if (!productResult.rows.length) {
      return res.status(404).json(errorBody('NOT_FOUND', 'Product not found'));
    }

    const variantRows = await db.query('SELECT id AS sku_id FROM variants WHERE product_id = $1 ORDER BY sku_id', [req.params.id]);
    res.json({
      product_id: req.params.id,
      available: variantRows.rows.length > 0,
      variants: variantRows.rows.map((variant) => ({ sku_id: variant.sku_id, available_quantity: null }))
    });
  } catch (error) {
    console.error(error);
    res.status(500).json(errorBody('INTERNAL', 'Failed to load availability'));
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

if (require.main === module) {
  start();
}

module.exports = {
  app,
  start,
  parsePagination,
  parseSort,
  buildFilters,
  errorBody,
  SORT_CLAUSES,
  DEFAULT_LIMIT,
  MAX_LIMIT
};
