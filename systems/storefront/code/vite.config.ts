import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // core listens on 4000 (systems/core/src/server.ts: PORT ?? 4000), NOT 3000.
    proxy: { '/api': { target: 'http://localhost:4000', changeOrigin: true } },
  },
})
