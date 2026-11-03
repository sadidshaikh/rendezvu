import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { errorMessage, log } from '../log.ts'
import type { InstantRoomRegistry, SavedRoom } from './instant-rooms.ts'
import { isMeetCode } from './meet-code.ts'

const FILE = 'rooms.json'
const VERSION = 1

interface StateFile {
  version: number
  savedAt: number
  rooms: SavedRoom[]
}

/**
 * Writes the registry to `${dir}/rooms.json`. Through a temporary file and a
 * rename, so a crash mid-write never leaves half a file behind.
 */
export async function saveRooms(dir: string, registry: InstantRoomRegistry): Promise<number> {
  const rooms = registry.snapshot()
  const body: StateFile = { version: VERSION, savedAt: Date.now(), rooms }
  await mkdir(dir, { recursive: true })
  const target = path.join(dir, FILE)
  const temp = `${target}.tmp`
  await writeFile(temp, JSON.stringify(body))
  await rename(temp, target)
  return rooms.length
}

/** Loads what the last run saved. A missing or broken file starts empty; it never stops the server. */
export async function loadRooms(dir: string, registry: InstantRoomRegistry): Promise<void> {
  let raw: string
  try {
    raw = await readFile(path.join(dir, FILE), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log('state_load_failed', { error: errorMessage(err) })
    return
  }
  try {
    const parsed = JSON.parse(raw) as Partial<StateFile>
    if (parsed.version !== VERSION || !Array.isArray(parsed.rooms)) throw new Error('unknown format')
    const rooms = parsed.rooms.filter(isSavedRoom)
    log('state_loaded', { rooms: registry.restore(rooms) })
  } catch (err) {
    log('state_load_failed', { error: errorMessage(err) })
  }
}

function isSavedRoom(r: unknown): r is SavedRoom {
  if (typeof r !== 'object' || r === null) return false
  const room = r as Record<string, unknown>
  return (
    typeof room.code === 'string' &&
    isMeetCode(room.code) &&
    typeof room.createdAt === 'number' &&
    (room.activatedAt === null || typeof room.activatedAt === 'number') &&
    typeof room.expiresAt === 'number'
  )
}
