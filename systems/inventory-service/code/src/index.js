const express = require('express');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 4003;
const inventory = {
  'sku-001': {
    id: 'inv-001',
    sku_id: 'sku-001',
    available_quantity: 100,
    reserved_quantity: 0,
    status: 'in_stock',
    location: 'warehouse-1'
  }
};

app.get('/inventory/sku/:skuId', (req, res) => {
  const item = inventory[req.params.skuId];
  if (!item) {
    return res.status(404).json({ error: 'Inventory item not found' });
  }
  res.json(item);
});

app.get('/inventory/sku/:skuId/availability', (req, res) => {
  const item = inventory[req.params.skuId];
  if (!item) {
    return res.status(404).json({ error: 'Inventory item not found' });
  }
  res.json({ sku_id: item.sku_id, available_quantity: item.available_quantity, status: item.status });
});

app.post('/inventory/sku/:skuId/reserve', (req, res) => {
  const item = inventory[req.params.skuId];
  if (!item) {
    return res.status(404).json({ error: 'Inventory item not found' });
  }

  const { quantity } = req.body;
  if (typeof quantity !== 'number' || quantity <= 0) {
    return res.status(400).json({ error: 'quantity must be a positive number' });
  }

  if (item.available_quantity < quantity) {
    return res.status(409).json({ error: 'Insufficient inventory' });
  }

  item.available_quantity -= quantity;
  item.reserved_quantity += quantity;
  res.json(item);
});

app.post('/inventory/sku/:skuId/release', (req, res) => {
  const item = inventory[req.params.skuId];
  if (!item) {
    return res.status(404).json({ error: 'Inventory item not found' });
  }

  const { quantity } = req.body;
  if (typeof quantity !== 'number' || quantity <= 0) {
    return res.status(400).json({ error: 'quantity must be a positive number' });
  }

  item.available_quantity += quantity;
  item.reserved_quantity = Math.max(0, item.reserved_quantity - quantity);
  res.json(item);
});

app.post('/inventory/adjustments', (req, res) => {
  const { sku_id, quantity } = req.body;
  const item = inventory[sku_id];
  if (!item) {
    return res.status(404).json({ error: 'Inventory item not found' });
  }
  if (typeof quantity !== 'number') {
    return res.status(400).json({ error: 'quantity must be a number' });
  }
  item.available_quantity += quantity;
  res.json(item);
});

app.listen(PORT, () => {
  console.log(`inventory-service listening on port ${PORT}`);
});
