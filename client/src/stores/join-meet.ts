import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface JoinMeetState {
  /** Remembered across visits so the lobby pre-fills it. */
  userName: string
  setUserName: (name: string) => void
}

export const useJoinMeetStore = create<JoinMeetState>()(
  persist(
    (set) => ({
      userName: '',
      setUserName: (userName) => set({ userName }),
    }),
    { name: 'rendezvu-join' },
  ),
)
