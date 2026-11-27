import { decryptFile, WSClient } from '@wecom/aibot-node-sdk'
import { ExpiringMedia } from './expiring-media.js'
import { attachment, maxMediaCount, mediaFields, platformMediaUrl } from './media.js'
import { channelSecret, type ChannelRuntime } from './runtime.js'
import type { AttachmentReference, Destination, ImTransport, Incoming, Reply } from './transport.js'

export interface WecomConfig {
  botId: string
  secretEnv?: string
  allowedUserIds?: string[]
  allowedUsers?: string[]
}

interface EncryptedFile {url?: string; aeskey?: string}
interface WecomInput {
  msgid?: string; aibotid?: string; from?: {userid?: string}; chattype?: string; msgtype?: string
  text?: {content?: string}
  image?: EncryptedFile
  file?: EncryptedFile
  video?: EncryptedFile
  voice?: {content?: string}
  mixed?: {msg_item?: {msgtype?: string; text?: {content?: string}; image?: EncryptedFile}[]}
}

const wecomHosts = new Set(['ww-aibot-img-1258476243.cos.ap-guangzhou.myqcloud.com', 'wwfile.weixin.qq.com'])

export function decodeWecom(message: WecomInput | undefined, botId: string, media?: ExpiringMedia): Incoming | undefined {
  const user = message?.from?.userid
  if (!user || message?.aibotid !== botId || message.chattype !== 'single' || !message.msgid) { return }
  const target = {user, chat: user}
  const id = message.msgid
  const mixed = message.msgtype === 'mixed' && Array.isArray(message.mixed?.msg_item) ? message.mixed.msg_item : []
  const text = message.msgtype === 'mixed'
    ? mixed.filter(item => item?.msgtype === 'text').map(item => item.text?.content).filter(Boolean).join('\n')
    : (message.msgtype === 'text' ? message.text?.content : message.msgtype === 'voice' ? message.voice?.content : '') ?? ''
  const encrypted = mixed.filter(item => item?.msgtype === 'image').slice(0, maxMediaCount + 1)
    .map(item => ({file: item.image, kind: 'image' as const}))
  if (message.msgtype === 'image') { encrypted.push({file: message.image, kind: 'image'}) }
  const file = message.msgtype === 'video' ? message.video : message.msgtype === 'file' ? message.file : undefined
  const references = [
    ...encrypted,
    ...(message.msgtype === 'file' || message.msgtype === 'video' ? [{file, kind: 'file' as const}] : []),
  ].map(item => {
    const url = platformMediaUrl(item.file?.url, wecomHosts)
    const tagged = attachment(url?.href, {kind: item.kind})
    const key = item.file?.aeskey
    if (!media || !url || !tagged || typeof key !== 'string') { return }
    const encoded = /^[\da-f]{64}$/iu.test(key) ? Buffer.from(key, 'hex').toString('base64') : key
    if (!/^[A-Za-z0-9+/]{43}=?$/u.test(encoded)) { return }
    return media.remember(target, id, tagged, url, bytes => decryptFile(bytes, encoded))
  })
  if (message.msgtype === 'voice' && message.voice) { references.push(undefined) }
  const resources = mediaFields(references)
  if ((typeof text === 'string' && text.trim()) || resources.attachments || resources.mediaUnavailable) {
    return { ...target, id, text: typeof text === 'string' ? text : '', ...resources }
  }
}

export class WecomTransport implements ImTransport {
  readonly maxTextBytes = 3900

  constructor(readonly id: string, private readonly client: WSClient, private readonly access: (d: Destination) => boolean,
    private readonly media?: ExpiringMedia) {}

  permits(target: Destination): boolean { return target.chat === target.user && this.access(target) }

  async readAttachment(target: Destination, messageId: string, reference: AttachmentReference) {
    if (!this.permits(target) || !this.media) { throw new Error('企业微信媒体没有读取权限') }
    return this.media.read(target, messageId, reference)
  }

  async send(target: Destination, reply: Reply): Promise<string> {
    if (!this.permits(target)) throw new Error('Unauthorized WeCom recipient')
    const content = reply.inspectTask ? reply.text + '\n\n`/inspect ' + reply.inspectTask + '`' : reply.text
    const receipt = await this.client.sendMessage(target.user, { msgtype: 'markdown', markdown: { content } })
    // aibot_send_msg returns a request acknowledgement, not an editable message identifier.
    return receipt.headers.req_id
  }

  edit(target: Destination, _receipt: string, reply: Reply): Promise<string> {
    return this.send(target, reply)
  }
}

export function startWecom(config: WecomConfig, runtime: ChannelRuntime): void {
  runtime.signal.throwIfAborted()
  const secret = channelSecret(runtime, 'secret', config.secretEnv ?? 'WECOM_BOT_SECRET')
  if (!config.botId || !secret) throw new Error('WeCom needs a botId and a bot secret')
  const id = 'wecom/' + config.botId
  const ws = new WSClient({
    botId: config.botId, secret, maxReconnectAttempts: -1,
    logger: {
      debug() {}, info() {}, warn() {},
      error() { runtime.warn('WeCom WebSocket error') },
    },
  })
  const media = new ExpiringMedia(runtime.signal)
  const gateway = runtime.mount(new WecomTransport(id, ws, runtime.access(id, config.allowedUserIds ?? config.allowedUsers), media))
  const receive = (frame: {body?: WecomInput}) => {
    const input = decodeWecom(frame.body, config.botId, media)
    if (input && !runtime.signal.aborted) void gateway.receive(input).catch(() => runtime.warn('WeCom message processing failed'))
  }
  for (const event of ['message.text', 'message.image', 'message.file', 'message.video', 'message.voice', 'message.mixed'] as const) {
    ws.on(event, receive)
  }
  ws.on('error', () => runtime.warn('WeCom connection failed'))
  runtime.signal.addEventListener('abort', () => ws.disconnect(), { once: true })
  ws.connect()
}
