import http from 'node:http'
import https from 'node:https'
import { readFileSync } from 'node:fs'
import type { Config } from './config.ts'

export function createServer(config: Config): http.Server {
  const handler: http.RequestListener = (req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('ok')
      return
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('not found')
  }

  if (!config.tls) return http.createServer(handler)

  return https.createServer(
    { cert: readFileSync(config.tls.certFile), key: readFileSync(config.tls.keyFile) },
    handler,
  )
}
