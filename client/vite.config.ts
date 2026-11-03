import { createReadStream, existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { defineConfig, type Plugin } from 'vite'
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

// MediaPipe's WebAssembly runtime (~13 MB), served from our own origin at
// /mediapipe/ instead of a CDN. Only the effect that needs it fetches it, the
// first time someone turns background blur on.
const mediapipeWasmDir = path.resolve(import.meta.dirname, '../node_modules/@mediapipe/tasks-vision/wasm')
// The SIMD build and the fallback for browsers without SIMD. FilesetResolver picks one.
const mediapipeFiles = readdirSync(mediapipeWasmDir).filter((f) => f.startsWith('vision_wasm_internal') || f.startsWith('vision_wasm_nosimd_internal'))

function mediapipeWasm(): Plugin {
  return {
    name: 'rendezvu-mediapipe-wasm',
    configureServer(server) {
      server.middlewares.use('/mediapipe', (req, res, next) => {
        const file = ((req.url ?? '').split('?')[0] ?? '').replace(/^\//, '')
        if (!mediapipeFiles.includes(file)) return next()
        res.setHeader('Content-Type', file.endsWith('.wasm') ? 'application/wasm' : 'text/javascript')
        createReadStream(path.join(mediapipeWasmDir, file)).pipe(res)
      })
    },
    generateBundle() {
      for (const file of mediapipeFiles) {
        this.emitFile({ type: 'asset', fileName: `mediapipe/${file}`, source: readFileSync(path.join(mediapipeWasmDir, file)) })
      }
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), mediapipeWasm()],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, 'src') },
  },
  server: {
    port: 3000,
    host: true,
    https,
  },
})
