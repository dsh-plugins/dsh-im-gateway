import { createHmac, timingSafeEqual } from 'node:crypto'
import { attachment, maxMediaCount, mediaFields, mediaResponse, platformMediaUrl, qqMediaHosts } from '../media.js'
import { requiredSecret, type ChannelRuntime } from '../runtime.js'
import type { Destination, Incoming, Reply } from '../transport.js'
import { CallbackError, messageText, signedEvents } from './signed-events.js'

export interface OneBotConfig {
  selfId: string
  apiBase: string
  accessTokenEnv?: string
  eventSecretEnv?: string
  allowedUserIds?: string[]
}

function qqNumber(value: unknown): string | undefined {
  if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value))) return
  return String(value)
}

function textOnly(message: unknown): string {
  if (typeof message === 'string') {
    // CQ escaping is applied to text segments in the string-form wire representation.
    return message.replace(/\[CQ:[^\]]*\]/g, '').replace(/&#91;/g, '[').replace(/&#93;/g, ']').replace(/&amp;/g, '&')
  }
  if (Array.isArray(message)) return message.map(part =>
    part?.type === 'text' && typeof part.data?.text === 'string' ? part.data.text : '').join('')
  return ''
}

export function startOneBot(config: OneBotConfig, runtime: ChannelRuntime): void {
  const selfId = qqNumber(config.selfId)
  if (!selfId) throw new Error('OneBot selfId must be a numeric bot account')
  const base = new URL(config.apiBase)
  if (base.username || base.password || base.search || base.hash ||
      !['https:', 'http:'].includes(base.protocol)) {
    throw new Error('OneBot apiBase must be an HTTP(S) action URL')
  }
  if (!base.pathname.endsWith('/')) base.pathname += '/'
  const token = requiredSecret(runtime, 'accessToken', config.accessTokenEnv ?? 'ONEBOT_ACCESS_TOKEN')
  const secret = requiredSecret(runtime, 'eventSecret', config.eventSecretEnv ?? 'ONEBOT_EVENT_SECRET')
  const id = 'onebot/' + selfId
  const access = runtime.access(id, config.allowedUserIds)
  const permits = (target: Destination) => target.chat === target.user && !!qqNumber(target.user) && target.user !== selfId && access(target)

  async function action(name: string, data: unknown): Promise<Record<string, unknown>> {
    const response = await fetch(new URL(name, base), {
      method:'POST', redirect:'error', signal:AbortSignal.any([runtime.signal,AbortSignal.timeout(15000)]),
      headers:{authorization:'Bearer ' + token,'content-type':'application/json'},body:JSON.stringify(data),
    })
    if (!response.ok) throw new Error('OneBot action unavailable (' + response.status + ')')
    const result = await response.json()
    if (result?.status !== 'ok' || result.retcode !== 0) throw new Error('OneBot action failed')
    return result.data
  }
  let identity: Promise<void> | undefined
  async function checkIdentity() {
    if (!identity) identity = action('get_login_info', {}).then(data => {
      if (qqNumber(data?.user_id) !== selfId) throw new Error('OneBot outbound account mismatch')
    }).catch(error => { identity = undefined; throw error })
    return identity
  }

  async function send(target: Destination, reply: Reply) {
    if (!permits(target)) throw new Error('OneBot private recipient unavailable')
    await checkIdentity()
    const result = await action('send_private_msg', {
      user_id:Number(target.user), message:[{type:'text',data:{text:messageText(reply)}}],
    })
    if (!Number.isSafeInteger(result?.message_id)) throw new Error('Missing OneBot message receipt')
    return String(result.message_id)
  }
  const gateway = runtime.mount({
    id, permits, send, edit: (target, _previous, reply) => send(target,reply),
    async readAttachment(target, _messageId, reference) {
      const url = platformMediaUrl(reference.resource, qqMediaHosts)
      if (!permits(target) || !url) { throw new Error('OneBot 附件不可读取') }
      return mediaResponse(await fetch(url, {
        redirect: 'error', signal: AbortSignal.any([runtime.signal, AbortSignal.timeout(15000)]),
      }), reference)
    },
  })
  runtime.webhook('/prism/im/onebot', signedEvents((headers, raw) => {
    const sig = headers['x-signature']
    if (headers['x-self-id'] !== selfId || typeof sig !== 'string' || !/^sha1=[0-9a-f]{40}$/i.test(sig)) return false
    return timingSafeEqual(Buffer.from(sig.slice(5),'hex'), createHmac('sha1',secret).update(raw).digest())
  }, async event => {
    if (qqNumber(event.self_id) !== selfId) throw new CallbackError(403)
    if (event.post_type !== 'message' || event.message_type !== 'private' || event.sub_type !== 'friend') return {}
    const user = qqNumber(event.user_id)
    const sender = event.sender as {user_id?:unknown; nickname?:unknown} | undefined
    if (!user || user === selfId || (sender?.user_id !== undefined && qqNumber(sender.user_id) !== user) ||
        !Number.isSafeInteger(event.message_id)) return {}
    const text = textOnly(event.message)
    const resources = Array.isArray(event.message)
      ? mediaFields(event.message.filter(part => ['image', 'video', 'file', 'record'].includes(part?.type))
        .slice(0, maxMediaCount + 1).map(part => attachment(platformMediaUrl(part?.data?.url, qqMediaHosts)?.href, {
          name: part?.data?.name, kind: part.type === 'image' ? 'image' : undefined,
        })))
      : {mediaUnavailable: typeof event.message === 'string' && /\[CQ:(?:image|video|file|record),/u.test(event.message) || undefined} as const
    if (text.trim() || ('attachments' in resources && resources.attachments) || resources.mediaUnavailable) {
      const input: Incoming = {chat:user,user,id:String(event.message_id),text,...resources,
        ...(typeof sender?.nickname === 'string' && {username:sender.nickname})}
      await gateway.receive(input)
    }
    return {}
  }))
}
