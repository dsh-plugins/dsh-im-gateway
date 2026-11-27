import type { AttachmentReference, BinaryMedia } from './transport.js'

export const maxMediaBytes = 16 * 1024 * 1024
export const maxMediaCount = 8
export const qqMediaHosts = new Set(['gchat.qpic.cn', 'c2cpicdw.qpic.cn', 'multimedia.nt.qq.com.cn', 'multimedia.nt.qq.com'])

const supported = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'video/mp4', 'video/webm', 'video/quicktime'])

function mediaName(value: unknown): string | undefined {
  if (typeof value !== 'string') { return }
  return value.split(/[\\/]/u).at(-1)?.replace(/[\u0000-\u001f\u007f]/gu, '').trim().slice(0, 200) || undefined
}

function mime(value: unknown): string | undefined {
  return typeof value === 'string' ? value.split(';', 1)[0]?.trim().toLowerCase() : undefined
}

export function attachment(resource: unknown, meta: {
  name?: unknown; mimeType?: unknown; size?: unknown; kind?: 'image' | 'file'
} = {}): AttachmentReference | undefined {
  if (typeof resource !== 'string' || resource.length > 4096 || !resource.trim() ||
    /[\u0000-\u001f\u007f]/u.test(resource)) { return }
  const name = mediaName(meta.name)
  const mimeType = mime(meta.mimeType)
  if ((mimeType && mimeType !== 'application/octet-stream' && !supported.has(mimeType)) ||
    (typeof meta.size === 'number' && (!Number.isSafeInteger(meta.size) || meta.size <= 0 || meta.size > maxMediaBytes))) {
    return
  }
  return {resource, ...(name && {name}), ...(mimeType && {mimeType}), ...(meta.kind && {kind: meta.kind})}
}

export function mediaFields(rows: (AttachmentReference | undefined)[]): {
  attachments?: AttachmentReference[]
  mediaUnavailable?: true
} {
  const attachments = rows.filter((row): row is AttachmentReference => row !== undefined).slice(0, maxMediaCount)
  return {
    ...(attachments.length && {attachments}),
    ...(attachments.length < rows.length && {mediaUnavailable: true}),
  }
}

export function platformMediaUrl(value: unknown, hosts: ReadonlySet<string>): URL | undefined {
  if (typeof value !== 'string' || value.length > 4096) { return }
  try {
    const url = new URL(value.startsWith('//') ? 'https:' + value : value)
    if (url.protocol === 'https:' && !url.port && !url.username && !url.password && !url.hash &&
      hosts.has(url.hostname)) { return url }
  } catch {
    return undefined
  }
}

export async function readMedia(stream: AsyncIterable<Uint8Array>, limit = maxMediaBytes): Promise<Buffer> {
  const parts: Uint8Array[] = []
  let size = 0
  for await (const part of stream) {
    size += part.byteLength
    if (size > limit) { throw new Error('IM 媒体超过允许大小') }
    parts.push(part)
  }
  if (!size) { throw new Error('IM 媒体为空') }
  return Buffer.concat(parts, size)
}

export async function responseBytes(response: Response, limit = maxMediaBytes): Promise<Buffer> {
  const declaredSize = response.headers.get('content-length')
  if (!response.ok || !response.body || (declaredSize !== null && Number(declaredSize) > limit)) {
    await response.body?.cancel()
    throw new Error('无法读取 IM 媒体')
  }
  const body = response.body
  const parts = (async function* () {
    const reader = body.getReader()
    try {
      while (true) {
        const part = await reader.read()
        if (part.done) { return }
        yield part.value
      }
    } finally {
      try { await reader.cancel() }
      finally { reader.releaseLock() }
    }
  })()
  return readMedia(parts, limit)
}

export async function mediaResponse(response: Response, meta: AttachmentReference): Promise<BinaryMedia> {
  return binaryMedia(await responseBytes(response), meta, response.headers.get('content-type'))
}

export function binaryMedia(bytes: Buffer, meta: AttachmentReference, remoteMime?: string | null): BinaryMedia {
  if (!bytes.length || bytes.length > maxMediaBytes) { throw new Error('IM 媒体大小无效') }
  const front = bytes.subarray(0, 32)
  let mimetype: string | undefined
  if (front[0] === 0xff && front[1] === 0xd8 && front[2] === 0xff) {
    mimetype = 'image/jpeg'
  } else if (front.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    mimetype = 'image/png'
  } else if (/^GIF8[79]a/u.test(front.toString('ascii', 0, 6))) {
    mimetype = 'image/gif'
  } else if (front.toString('ascii', 0, 4) === 'RIFF' && front.toString('ascii', 8, 12) === 'WEBP') {
    mimetype = 'image/webp'
  } else if (front.toString('ascii', 4, 8) === 'ftyp') {
    const brand = front.toString('ascii', 8, 12)
    if (brand === 'qt  ') { mimetype = 'video/quicktime' }
    else if (/^(?:isom|iso[2-9]|avc1|mp4[12]|M4V |MSNV|dash|3gp.)$/u.test(brand)) { mimetype = 'video/mp4' }
  } else if (front.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) &&
    bytes.subarray(0, 4096).includes(Buffer.from([0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d]))) {
    mimetype = 'video/webm'
  } else if ((mime(remoteMime) === 'video/quicktime' || meta.mimeType === 'video/quicktime') &&
    ['moov', 'mdat', 'wide', 'free'].includes(front.toString('ascii', 4, 8))) {
    mimetype = 'video/quicktime'
  }
  if (!mimetype || (meta.kind === 'image' && !mimetype.startsWith('image/'))) {
    throw new Error('IM 媒体没有可识别的文件格式')
  }
  return {bytes, mimeType: mimetype, ...(meta.name && {name: meta.name})}
}
