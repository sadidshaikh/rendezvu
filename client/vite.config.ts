import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Serve over HTTPS when the shared dev cert exists (npm run certs), so camera
// access works from other devices on the LAN. Production builds are static.
const certDir = path.resolve(import.meta.dirname, '../certs')
const certPath = path.join(certDir, 'cert.pem')
const keyPath = path.join(certDir, 'key.pem')
const https = existsSync(certPath) && existsSync(keyPath)
  ? { cert: readFileSync(certPath), key: readFileSync(keyPath) }
  : undefined

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, 'src') },
  },
  server: {
    port: 3000,
    host: true,
    https,
  },
})
