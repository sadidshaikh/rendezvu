import { create } from 'zustand'

/**
 * What the user wants: mic on or off, camera on or off. The live tracks are in
 * the peer store. They can briefly disagree (a permission prompt is open), and
 * intent only flips once a device has actually started.
 */
interface MeetState {
  isMuted: boolean
  isVideoOff: boolean

  toggleMute: () => void
  toggleVideo: () => void
  clearMeet: () => void
}

export const useMeetStore = create<MeetState>()((set) => ({
  isMuted: true,
  isVideoOff: true,

  toggleMute: () => set((state) => ({ isMuted: !state.isMuted })),
  toggleVideo: () => set((state) => ({ isVideoOff: !state.isVideoOff })),
  clearMeet: () => set({ isMuted: true, isVideoOff: true }),
}))
