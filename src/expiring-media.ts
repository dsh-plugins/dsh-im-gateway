import { randomUUID } from 'node:crypto'
import { binaryMedia, maxMediaBytes, responseBytes } from './media.js'
import type { AttachmentReference, Destination } from './transport.js'

interface Download {
  target: Destination
  messageId: string
  expires: number
  url: URL
  decrypt?: (bytes: Buffer) => Buffer
}

/** 短期 CDN 签名和媒体解密密钥只留在网关内存中。收件队列只引用随机标识。 */
export class ExpiringMedia {
  private readonly sources = new Map<string, Download>()

  constructor(private readonly signal: AbortSignal, private readonly request: typeof fetch = fetch) {
    signal.addEventListener('abort', () => this.sources.clear(), {once: true})
  }

  remember(target: Destination, messageId: string, reference: AttachmentReference, url: URL,
    decrypt?: (bytes: Buffer) => Buffer): AttachmentReference {
    const now = Date.now()
    for (const [id, item] of this.sources) {
      if (item.expires <= now) { this.sources.delete(id) }
    }
    if (this.sources.size >= 256) {
      const oldest = this.sources.keys().next().value
      if (oldest) { this.sources.delete(oldest) }
    }
    const id = randomUUID()
    this.sources.set(id, {
      target: {chat: target.chat, user: target.user}, messageId, expires: now + 300000, url, decrypt,
    })
    return {...reference, resource: id}
  }

  async read(target: Destination, messageId: string, reference: AttachmentReference) {
    const source = this.sources.get(reference.resource)
    if (!source || source.expires <= Date.now() || source.messageId !== messageId ||
      target.chat !== source.target.chat || target.user !== source.target.user) {
      throw new Error('IM 临时媒体已过期')
    }
    try {
      const response = await this.request(source.url, {
        redirect: 'error', signal: AbortSignal.any([this.signal, AbortSignal.timeout(15000)]),
      })
      const bytes = await responseBytes(response, maxMediaBytes + (source.decrypt ? 32 : 0))
      return binaryMedia(source.decrypt ? source.decrypt(bytes) : bytes, reference, response.headers.get('content-type'))
    } finally {
      this.sources.delete(reference.resource)
    }
  }
}
