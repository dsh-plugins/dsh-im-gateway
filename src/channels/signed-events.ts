import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'

export class CallbackError extends Error {
  constructor(readonly status: number) { super('Invalid channel callback') }
}

/** Authentication always consumes the original bytes, including JSON whitespace. */
export function signedEvents(
  authenticate: (headers: IncomingHttpHeaders, raw: Buffer) => boolean,
  handle: (event: Record<string, unknown>) => Promise<unknown>,
) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (req.method !== 'POST') throw new CallbackError(405)
      const buffers: Buffer[] = []
      let bytes = 0
      for await (const chunk of req.iterator({destroyOnReturn: false})) {
        const value = Buffer.from(chunk)
        bytes += value.length
        if (bytes > 1_048_576) { req.resume(); throw new CallbackError(413) }
        buffers.push(value)
      }
      const raw = Buffer.concat(buffers)
      if (!authenticate(req.headers, raw)) throw new CallbackError(401)
      let event: unknown
      try { event = JSON.parse(raw.toString('utf8')) } catch { throw new CallbackError(400) }
      if (!event || typeof event !== 'object' || Array.isArray(event)) throw new CallbackError(400)
      const result = await handle(event as Record<string, unknown>)
      res.writeHead(200, {'content-type': 'application/json; charset=utf-8', 'cache-control':'no-store'})
      res.end(JSON.stringify(result ?? {}))
    } catch (error) {
      res.writeHead(error instanceof CallbackError ? error.status : 503, {'cache-control':'no-store'})
      res.end()
    }
  }
}

export function credential(envName: string): string {
  const value = process.env[envName]
  if (!value?.trim()) throw new Error('Channel credential missing from ' + envName)
  return value
}

export function messageText(reply: {text: string; inspectTask?: string}): string {
  return reply.text + (reply.inspectTask ? '\n/inspect ' + reply.inspectTask : '')
}
