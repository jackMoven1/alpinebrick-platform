const express = require('express')
const path = require('path')
const { createProxyMiddleware } = require('http-proxy-middleware')

const app = express()
app.use(express.json())

const PORT = process.env.PORT || 3000
const catalogBaseUrl = process.env.CATALOG_SERVICE_URL || 'http://localhost:4001'
const orderBaseUrl = process.env.ORDER_SERVICE_URL || 'http://localhost:4002'
const inventoryBaseUrl = process.env.INVENTORY_SERVICE_URL || 'http://localhost:4003'
const affiliateBaseUrl = process.env.AFFILIATE_SERVICE_URL || 'http://localhost:4004'

// Proxy API calls to backend services
app.use('/catalog', createProxyMiddleware({
  target: catalogBaseUrl,
  changeOrigin: true,
  pathRewrite: {
    '^/catalog': '/catalog'
  },
  logLevel: 'info'
}))

app.use('/orders', createProxyMiddleware({
  target: orderBaseUrl,
  changeOrigin: true,
  pathRewrite: {
    '^/orders': '/api/orders'
  }
}))

app.use('/inventory', createProxyMiddleware({
  target: inventoryBaseUrl,
  changeOrigin: true,
  pathRewrite: {
    '^/inventory': '/inventory'
  }
}))

app.use('/affiliates', createProxyMiddleware({
  target: affiliateBaseUrl,
  changeOrigin: true,
  pathRewrite: {
    '^/affiliates': '/affiliate'
  }
}))

// Serve static files from React build
const distPath = path.join(__dirname, 'dist')
app.use(express.static(distPath))

// SPA fallback: serve index.html for all other routes (client-side routing)
app.get('*', (req, res) => {
  res.sendFile(path.join(distPath, 'index.html'), (err) => {
    if (err) {
      console.error('Error serving index.html:', err)
      res.status(500).send('Error loading application')
    }
  })
})

// Error handling
app.use((err, req, res, next) => {
  console.error(err.stack)
  res.status(500).json({ error: 'Internal server error' })
})

app.listen(PORT, () => {
  console.log(`[storefront] Listening on port ${PORT}`)
  console.log(`[storefront] Serving React app from ${distPath}`)
})
