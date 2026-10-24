import { useEffect, useState } from 'react'
import { wsServerUri } from '@/lib/config'
import { SignalingClient, type ConnState } from '@/services/signaling/client'

/**
 * Opens a signaling connection while `enabled` is true. `client` is non-null
 * only once the server has sent `welcome`, so callers can send right away.
 */
export function useSignaling(enabled: boolean) {
  const [client, setClient] = useState<SignalingClient | null>(null)
  const [connState, setConnState] = useState<ConnState>('connecting')

  useEffect(() => {
    if (!enabled) {
      setClient(null)
      setConnState('connecting')
      return
    }

    const c = new SignalingClient(wsServerUri)
    c.onStateChange = (state) => {
      setConnState(state)
      setClient(state === 'connected' ? c : null)
    }
    c.connect()

    return () => {
      c.onStateChange = undefined
      c.dispose()
      setClient(null)
    }
  }, [enabled])

  return { client, connState }
}
