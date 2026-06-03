const express = require('express');
const path = require('path');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const catalogBaseUrl = process.env.CATALOG_SERVICE_URL || 'http://localhost:4001';
const orderBaseUrl = process.env.ORDER_SERVICE_URL || 'http://localhost:4002';

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/products', async (req, res) => {
  const response = await fetch(`${catalogBaseUrl}/catalog/products`);
  const products = await response.json();
  res.json(products);
});

app.post('/api/checkout', async (req, res) => {
  const response = await fetch(`${orderBaseUrl}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req.body)
  });

  const data = await response.json();
  res.status(response.status).json(data);
});

app.listen(PORT, () => {
  console.log(`storefront listening on port ${PORT}`);
});
