import type { ApiError as ApiErrorBody } from '@rendezvu/protocol'

export class ApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

/** Reads the server's error body: JSON `{ error, code }` or plain text. */
export async function parseApiError(res: Response): Promise<ApiError> {
  if (res.headers.get('Content-Type')?.includes('application/json')) {
    try {
      const body = (await res.json()) as Partial<ApiErrorBody>
      return new ApiError(res.status, body.code || 'ERROR', body.error || res.statusText || `${res.status}`)
    } catch {
      // Fall through to text.
    }
  }
  const text = await res.text().catch(() => '')
  return new ApiError(res.status, 'ERROR', text.trim() || res.statusText || `${res.status}`)
}

export async function apiFetch<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'include',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) throw await parseApiError(res)
  return (await res.json()) as T
}
