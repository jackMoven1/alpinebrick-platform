const express = require('express');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 4002;
const CATALOG_SERVICE_URL = process.env.CATALOG_SERVICE_URL || 'http://catalog-service:4001';
const INVENTORY_SERVICE_URL = process.env.INVENTORY_SERVICE_URL || 'http://inventory-service:4003';
const AFFILIATE_SERVICE_URL = process.env.AFFILIATE_SERVICE_URL || 'http://affiliate-service:4004';

const orders = [];

function calculateLineItem(product, item) {
  const variant = product.variants.find((v) => v.id === item.sku_id || v.sku === item.sku_id);
  if (!variant) return null;
  const unit_price = variant.price;
  const line_total = unit_price * item.quantity;
  return {
    id: `${item.sku_id}-${Date.now()}`,
    sku_id: variant.id,
    quantity: item.quantity,
    unit_price,
    line_total
  };
}

app.post('/api/orders', async (req, res) => {
  const { customer_id, items, affiliate_id, referral_code, payment_method } = req.body;
  if (!customer_id || !Array.isArray(items) || items.length === 0 || !payment_method) {
    return res.status(400).json({ error: 'customer_id, items, and payment_method are required' });
  }

  const orderLineItems = [];
  let total_amount = 0;
  const reservedItems = [];

  for (const item of items) {
    if (!item.product_id || !item.sku_id || !item.quantity) {
      return res.status(400).json({ error: 'Each item must include product_id, sku_id, and quantity' });
    }

    const productResponse = await fetch(`${CATALOG_SERVICE_URL}/catalog/products/${item.product_id}`);
    if (!productResponse.ok) {
      return res.status(400).json({ error: `Product not found: ${item.product_id}` });
    }

    const product = await productResponse.json();
    const lineItem = calculateLineItem(product, item);
    if (!lineItem) {
      return res.status(400).json({ error: `SKU not found: ${item.sku_id}` });
    }

    const inventoryResponse = await fetch(`${INVENTORY_SERVICE_URL}/inventory/sku/${lineItem.sku_id}/reserve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quantity: lineItem.quantity })
    });

    if (!inventoryResponse.ok) {
      const error = await inventoryResponse.json();
      for (const reserved of reservedItems) {
        await fetch(`${INVENTORY_SERVICE_URL}/inventory/sku/${reserved.sku_id}/release`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ quantity: reserved.quantity })
        });
      }
      return res.status(409).json({ error: `Inventory reservation failed for SKU ${lineItem.sku_id}`, details: error });
    }

    orderLineItems.push(lineItem);
    reservedItems.push({ sku_id: lineItem.sku_id, quantity: lineItem.quantity });
    total_amount += lineItem.line_total;
  }

  const commission_rate = 0.1;
  const commission_amount = affiliate_id || referral_code ? total_amount * commission_rate : 0;
  const order = {
    id: `order-${Date.now()}`,
    customer_id,
    status: 'pending',
    total_amount,
    currency: 'USD',
    payment_status: 'authorized',
    affiliate_id: affiliate_id || null,
    referral_code: referral_code || null,
    commission_rate: affiliate_id || referral_code ? commission_rate : 0,
    commission_amount,
    line_items: orderLineItems
  };

  orders.push(order);

  if (affiliate_id || referral_code) {
    await fetch(`${AFFILIATE_SERVICE_URL}/affiliate/commissions/${order.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        affiliate_id: affiliate_id || null,
        referral_code: referral_code || null,
        commission_rate: order.commission_rate,
        commission_amount: order.commission_amount
      })
    });
  }

  res.status(201).json(order);
});

app.get('/api/orders/:orderId', (req, res) => {
  const order = orders.find((o) => o.id === req.params.orderId);
  if (!order) {
    return res.status(404).json({ error: 'Order not found' });
  }
  res.json(order);
});

app.listen(PORT, () => {
  console.log(`order-service listening on port ${PORT}`);
});
