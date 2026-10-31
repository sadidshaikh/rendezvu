import { useEffect, useState } from 'react'
import { wsServerUri } from '@/lib/config'
import { SignalingClient, type ConnState } from '@/services/signaling/client'

/**
 * Opens a signaling connection while `enabled` is true. `client` becomes
 * non-null on the first `welcome`, so callers can send right away, and then
 * stays the same object through every reconnect. Setting it back to null on
 * a drop would make useCall tear the call down, media included, when only
 * the WebSocket went away.
 */
export function useSignaling(enabled: boolean) {
  const [client, setClient] = useState<SignalingClient | null>(null)
  const [connState, setConnState] = useState<ConnState>('connecting')
  const [reconnectAttempt, setReconnectAttempt] = useState(0)

  useEffect(() => {
    if (!enabled) {
      setClient(null)
      setConnState('connecting')
      setReconnectAttempt(0)
      return
    }

    const c = new SignalingClient(wsServerUri)
    c.onStateChange = (state, attempt) => {
      setConnState(state)
      setReconnectAttempt(attempt)
      if (state === 'connected') setClient(c)
    }
    c.connect()

    return () => {
      c.onStateChange = undefined
      c.onReconnected = undefined
      c.dispose()
      setClient(null)
    }
  }, [enabled])

  return { client, connState, reconnectAttempt }
}
