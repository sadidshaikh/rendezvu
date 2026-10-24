import type { ServerResponse } from 'node:http'
import type { ApiError } from '@rendezvu/protocol'

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
}

export function sendText(res: ServerResponse, status: number, text: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...headers })
  res.end(text)
}

/** JSON error in the shape every API route uses: `{ error, code }`. */
export function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  const body: ApiError = { error: message, code }
  sendJson(res, status, body)
}
