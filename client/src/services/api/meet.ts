import type { CreateMeetResponse } from '@rendezvu/protocol'
import { httpServerUri } from '@/lib/config'
import { apiFetch } from './http'

export function createMeet(): Promise<CreateMeetResponse> {
  return apiFetch('POST', `${httpServerUri}/meets/new`)
}
