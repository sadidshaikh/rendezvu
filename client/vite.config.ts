import { createReadStream, existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { defineConfig, loadEnv, type Plugin } from 'vite'
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

/**
 * Security headers for the whole site, with the signaling server's origin in
 * connect-src. Written to dist/_headers for Cloudflare Pages, and sent by
 * `vite preview` too, so the policy can be tested locally before deploying.
 */
function securityHeaders(serverDomain: string | undefined): Record<string, string> {
  const connect = serverDomain ? `https://${serverDomain} wss://${serverDomain}` : 'https: wss:'
  const csp = [
    "default-src 'self'",
    // WebAssembly (MediaPipe, RNNoise) without allowing JavaScript eval.
    "script-src 'self' 'wasm-unsafe-eval'",
    // The Phase 12 worker clock is a blob: worker.
    "worker-src 'self' blob:",
    `connect-src 'self' ${connect}`,
    // A background picture is a blob: URL.
    "img-src 'self' blob: data:",
    // React's style={…} attributes need inline styles.
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com',
    "media-src 'self' blob:",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ')
  return {
    'Content-Security-Policy': csp,
    'Permissions-Policy': 'camera=(self), microphone=(self), display-capture=(self)',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Content-Type-Options': 'nosniff',
  }
}

function pagesHeaders(serverDomain: string | undefined): Plugin {
  return {
    name: 'rendezvu-pages-headers',
    apply: 'build',
    generateBundle() {
      if (!serverDomain) this.warn('VITE_SERVER_DOMAIN is not set: the CSP allows any https:/wss: server')
      const site = Object.entries(securityHeaders(serverDomain)).map(([k, v]) => `  ${k}: ${v}`)
      const source = [
        '/*',
        ...site,
        // Content-hashed names: a new build means new names, so cache for good.
        '/assets/*',
        '  Cache-Control: public, max-age=31536000, immutable',
        // Fixed names: cached a day, then revalidated.
        '/mediapipe/*',
        '  Cache-Control: public, max-age=86400',
        '/models/*',
        '  Cache-Control: public, max-age=86400',
        '',
      ].join('\n')
      this.emitFile({ type: 'asset', fileName: '_headers', source })
    },
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, import.meta.dirname, 'VITE_')
  return {
    plugins: [react(), tailwindcss(), mediapipeWasm(), pagesHeaders(env.VITE_SERVER_DOMAIN)],
    resolve: {
      alias: { '@': path.resolve(import.meta.dirname, 'src') },
    },
    server: {
      port: 3000,
      host: true,
      https,
    },
    // The production headers, to test the CSP against a local build.
    preview: {
      port: 4173,
      host: true,
      https,
      headers: securityHeaders(env.VITE_SERVER_DOMAIN),
    },
  }
})
