import http from 'node:http'
import https from 'node:https'
import { readFileSync } from 'node:fs'
import type { Config } from './config.ts'
import { sendText } from './http/respond.ts'
import { errorMessage, log } from './log.ts'

export type RouteHandler = (req: http.IncomingMessage, res: http.ServerResponse) => void

/**
 * Path → handler. Each handler checks its own method so CORS preflight works.
 * A key ending in `/` also matches every path under it (`/sfu/sessions/`).
 */
export type Routes = Record<string, RouteHandler>

export function createServer(config: Config, routes: Routes): http.Server {
  const handler: http.RequestListener = (req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname

    if (path === '/healthz' && req.method === 'GET') {
      sendText(res, 200, 'ok')
      return
    }

    const route = routes[path] ?? prefixRoute(routes, path)
    if (!route) {
      sendText(res, 404, 'not found')
      return
    }

    try {
      route(req, res)
    } catch (err) {
      log('http_error', { path, error: errorMessage(err) })
      if (!res.headersSent) sendText(res, 500, 'internal error')
      else res.end()
    }
  }

  if (!config.tls) return http.createServer(handler)

  return https.createServer(
    { cert: readFileSync(config.tls.certFile), key: readFileSync(config.tls.keyFile) },
    handler,
  )
}

function prefixRoute(routes: Routes, path: string): RouteHandler | undefined {
  for (const [key, route] of Object.entries(routes)) {
    if (key.endsWith('/') && path.startsWith(key)) return route
  }
  return undefined
}
