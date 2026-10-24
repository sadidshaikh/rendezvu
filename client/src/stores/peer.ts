import { create } from 'zustand'
import type { PeerInfo } from '@rendezvu/protocol'

/** One remote participant. Later phases add their media and connection state. */
export interface RemotePeer {
  id: string
  name: string
  audio: boolean
  video: boolean
}

interface PeerState {
  /** True once the server has acknowledged our join with `joined`. */
  inRoom: boolean
  peers: Map<string, RemotePeer>

  setRoster: (peers: PeerInfo[]) => void
  addPeer: (peer: RemotePeer) => void
  removePeer: (id: string) => void
  clearAll: () => void
}

export const usePeerStore = create<PeerState>()((set) => ({
  inRoom: false,
  peers: new Map(),

  setRoster: (peers) =>
    set({
      inRoom: true,
      peers: new Map(peers.map((p) => [p.id, { id: p.id, name: p.name, audio: p.audio, video: p.video }])),
    }),

  addPeer: (peer) =>
    set((state) => {
      const peers = new Map(state.peers)
      peers.set(peer.id, peer)
      return { peers }
    }),

  removePeer: (id) =>
    set((state) => {
      if (!state.peers.has(id)) return state
      const peers = new Map(state.peers)
      peers.delete(id)
      return { peers }
    }),

  clearAll: () => set({ inRoom: false, peers: new Map() }),
}))
