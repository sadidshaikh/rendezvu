import { loadConfig } from './config.ts'
import { createServer } from './server.ts'

const SHUTDOWN_TIMEOUT_MS = 10_000

const config = loadConfig()
const server = createServer(config)

server.listen(config.port, config.host, () => {
  const scheme = config.tls ? 'https' : 'http'
  console.log(`Signaling server listening on ${scheme}://localhost:${config.port}`)
})

// Hosting platforms send SIGTERM before replacing the process on a deploy.
function shutdown(signal: string) {
  console.log(`${signal} received, shutting down`)
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS).unref()
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
