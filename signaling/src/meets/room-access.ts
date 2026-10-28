import type { RoomAccess } from './instant-rooms.ts'

export interface RoomAccessError {
  status: number
  code: string
  message: string
}

/**
 * How the call APIs (/ice-servers now, /sfu/* in Phase 4) refuse a room that
 * isn't active. One mapping, so every route says the same thing.
 */
export function roomAccessError(access: Exclude<RoomAccess, 'ok'>): RoomAccessError {
  switch (access) {
    case 'not-started':
      return { status: 403, code: 'ROOM_NOT_STARTED', message: 'This meeting has not started yet.' }
    case 'expired':
      return { status: 403, code: 'ROOM_EXPIRED', message: 'This meeting is no longer active.' }
    case 'unknown':
      return { status: 403, code: 'ROOM_NOT_FOUND', message: 'This meeting is not active.' }
  }
}
