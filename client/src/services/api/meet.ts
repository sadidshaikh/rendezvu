import type { CreateMeetResponse } from '@rendezvu/protocol'
import { httpServerUri } from '@/lib/config'
import { apiFetch } from './http'
import { saveHostToken } from './room-token'

/** Creates an instant meeting. Its host token is kept, so the creator joins without knocking. */
export async function createMeet(): Promise<CreateMeetResponse> {
  const meet = await apiFetch<CreateMeetResponse>('POST', `${httpServerUri}/meets/new`)
  if (meet.hostToken) saveHostToken(meet.meetCode, meet.hostToken)
  return meet
}
