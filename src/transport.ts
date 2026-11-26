/** Only call the gateway after the channel has authenticated the sender and the conversation. */
export interface Destination {
  chat: string
  user: string
}

export interface Incoming extends Destination {
  id: string
  text: string
}

export interface Reply {
  text: string
  inspectTask?: string
}

export interface ImTransport {
  /** Stable channel, tenant and bot namespace. Never put a credential in this identifier. */
  id: string
  permits(destination: Destination): boolean
  send(destination: Destination, reply: Reply): Promise<string>
  edit(destination: Destination, messageId: string, reply: Reply): Promise<string>
}

/** Keep surrogate pairs intact when splitting a response at the platform's UTF-16 limit. */
export function splitText(text: string, limit = 4000): string[] {
  if (!Number.isSafeInteger(limit) || limit < 2) throw new Error('Invalid chunk length')
  const parts: string[] = []
  let chunk = ''
  for (const letter of text) {
    if (chunk.length + letter.length > limit) {
      parts.push(chunk)
      chunk = ''
    }
    chunk += letter
  }
  if (chunk) parts.push(chunk)
  return parts
}
