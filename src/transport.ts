/** Only call the gateway after the channel has authenticated the sender and the conversation. */
export interface Destination {
  chat: string
  user: string
}

export interface Incoming extends Destination {
  id: string
  locale?: string
  username?: string
  text: string
}

export interface Reply {
  text: string
  inspectTask?: string
  inspectLabel?: string
  deliveryId?: string
}

export interface ImTransport {
  /** Stable channel, tenant and bot namespace. Never put a credential in this identifier. */
  id: string
  maxTextLength?: number
  maxTextBytes?: number
  permits(destination: Destination): boolean
  send(destination: Destination, reply: Reply): Promise<string>
  edit(destination: Destination, messageId: string, reply: Reply): Promise<string>
}

/** Keep surrogate pairs intact when splitting a response at the platform's UTF-16 limit. */
export function splitText(text: string, limit = 4000, byteLimit = Infinity): string[] {
  if (!Number.isSafeInteger(limit) || limit < 2) throw new Error('Invalid chunk length')
  if (!(byteLimit >= 4)) throw new Error('Invalid byte limit')
  const parts: string[] = []
  let bytes = 0
  let chunk = ''
  for (const letter of text) {
    const size = Number.isFinite(byteLimit) ? Buffer.byteLength(letter) : 0
    if (chunk.length + letter.length > limit || bytes + size > byteLimit) {
      bytes = 0
      parts.push(chunk)
      chunk = ''
    }
    bytes += size
    chunk += letter
  }
  if (chunk) parts.push(chunk)
  return parts
}
