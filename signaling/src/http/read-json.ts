import type { IncomingMessage } from 'node:http'

const DEFAULT_MAX_BODY_BYTES = 16 * 1024

/** The body went past the cap. Routes answer 413, as the guard does for Content-Length. */
export class BodyTooLargeError extends Error {
  constructor() {
    super('request body too large')
  }
}

/**
 * Reads and parses a JSON request body. The guard rejects a large
 * Content-Length up front, but a chunked body has none, so the cap is
 * enforced again while reading. Throws SyntaxError on invalid JSON.
 */
export async function readJson(req: IncomingMessage, maxBytes = DEFAULT_MAX_BODY_BYTES): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > maxBytes) throw new BodyTooLargeError()
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
