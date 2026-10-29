import type { ServerResponse } from 'node:http'

export interface ClientGone {
  /** Aborts when the client disconnects before the response is finished. */
  signal: AbortSignal
  /** Stop listening. Call once the upstream request has settled. */
  release: () => void
}

/**
 * For routes that call an upstream service: lets that call stop as soon as
 * nobody is waiting for its answer, and lets the route tell "the client left"
 * apart from "the upstream failed".
 */
export function watchClientGone(res: ServerResponse): ClientGone {
  const controller = new AbortController()
  // 'close' before the response is finished means the client went away.
  const onClose = () => {
    if (!res.writableFinished) controller.abort()
  }
  res.on('close', onClose)
  return { signal: controller.signal, release: () => res.off('close', onClose) }
}
