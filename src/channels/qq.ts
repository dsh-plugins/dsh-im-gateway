import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { attachment, maxMediaCount, mediaFields, mediaResponse, platformMediaUrl, qqMediaHosts } from '../media.js'
import { requiredSecret, type ChannelRuntime } from '../runtime.js'
import type { Destination, Reply } from '../transport.js'
import { CallbackError, messageText, signedEvents } from './signed-events.js'

export interface QQConfig { appId: string; appSecretEnv?: string; allowedUserIds?: string[] }

/** Tencent signs timestamp || rawBody with the Ed25519 key derived from the app secret. */
function signingKey(secret: string) {
  let seed = Buffer.from(secret)
  while (seed.length < 32) seed = Buffer.concat([seed,seed])
  const prefix = Buffer.from('302e020100300506032b657004220420','hex')
  return createPrivateKey({format:'der',type:'pkcs8',key:Buffer.concat([prefix,seed.subarray(0,32)])})
}

interface Window { id:string; at:number; used:number }
interface Frame { msg_id:string; msg_seq:number; expires:number }
const api = 'https://api.bot.qq.com'
const passiveWindow = 5 * 60_000
const openId = (id: unknown): id is string => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id)

export function startQQ(options: QQConfig, runtime: ChannelRuntime): void {
  if (!/^\d+$/.test(options.appId) || typeof options.appId !== 'string') throw new Error('Invalid QQ appId')
  const secret = requiredSecret(runtime, 'appSecret', options.appSecretEnv ?? 'QQ_BOT_SECRET')
  const privateKey = signingKey(secret)
  const publicKey = createPublicKey(privateKey)
  const id = 'qq/' + options.appId
  const access = runtime.access(id,options.allowedUserIds)
  const permits = (target: Destination) => target.chat === target.user && openId(target.user) && access(target)
  const key = (part:string, user:string) => [id,part,user].join('/')
  let token: {value:string;expires:number} | undefined
  let refresh: Promise<string> | undefined
  const signal = () => AbortSignal.any([runtime.signal, AbortSignal.timeout(15_000)])

  async function accessToken() {
    if (token && token.expires > Date.now() + 60_000) return token.value
    if (!refresh) refresh = (async () => {
      const response = await fetch(api + '/app/getAppAccessToken',{
        method:'POST', redirect:'error', signal:signal(),headers:{'content-type':'application/json'},
        body:JSON.stringify({appId:options.appId,clientSecret:secret}),
      })
      if (!response.ok) throw new Error('QQ token request failed (' + response.status + ')')
      const result = await response.json()
      const expires = Number(result?.expires_in)
      if (typeof result.access_token !== 'string' || !result.access_token || !Number.isFinite(expires) || expires <= 0) {
        throw new Error('QQ token unavailable')
      }
      token = {value:result.access_token, expires:Date.now()+expires*1000}
      return token.value
    })().finally(() => { refresh = undefined })
    return refresh
  }

  function remember(user:string, message:string, at:number) {
    const name = key('window',user)
    const current: Window | null = JSON.parse(runtime.state.get(name) ?? 'null')
    if (current && (current.id === message || current.at > at)) return
    runtime.state.set(name,JSON.stringify({id:message,at,used:0}))
  }

  // Persist the reply slot before posting. A transport retry reuses msg_id + msg_seq.
  function frame(user:string, receipt?:string): Frame | undefined {
    const slotKey = receipt && key('slot/' + user, receipt)
    const saved = slotKey && runtime.state.get(slotKey)
    if (saved) {
      const previous = JSON.parse(saved) as Frame | null
      return previous && previous.expires > Date.now() ? previous : undefined
    }
    const windowKey = key('window',user)
    const current: Window | null = JSON.parse(runtime.state.get(windowKey) ?? 'null')
    let result: Frame | undefined
    if (current && current.at + passiveWindow > Date.now() && current.used < 4) {
      result = {msg_id:current.id,msg_seq:++current.used,expires:current.at + passiveWindow}
      runtime.state.set(windowKey,JSON.stringify(current))
    }
    if (slotKey) runtime.state.set(slotKey,JSON.stringify(result ?? null))
    return result
  }

  async function send(target:Destination, reply:Reply): Promise<string> {
    if (!permits(target)) throw new Error('QQ private recipient unavailable')
    const slot = frame(target.user,reply.deliveryId)
    if (!slot && runtime.state.get(key('blocked', target.user)) === 'yes') throw new Error('QQ proactive messages disabled')
    const authorization = await accessToken()
    const response = await fetch(api + '/v2/users/' + encodeURIComponent(target.user) + '/messages', {
      method:'POST', redirect:'error', signal:signal(),
      headers:{authorization:'QQBot ' + authorization,'content-type':'application/json'},
      body:JSON.stringify({msg_type:0,content:messageText(reply),...(slot && {msg_id:slot.msg_id,msg_seq:slot.msg_seq})}),
    })
    const result = await response.json()
    if (response.status === 401 && token?.value === authorization) token = undefined
    const code = Number(result?.code ?? 0)
    if (slot && code === 40054005) return 'reply:' + slot.msg_id + ':' + slot.msg_seq
    if (!response.ok || code !== 0) throw new Error('QQ C2C delivery failed (' + response.status + '/' + code + ')')
    if (typeof result.id !== 'string' || !result.id) throw new Error('Missing QQ C2C message receipt')
    return result.id
  }

  const gateway = runtime.mount({
    id, permits, maxTextBytes: 3500, send, edit: (target, _prev, reply) => send(target,reply),
    async readAttachment(target, _messageId, reference) {
      const url = platformMediaUrl(reference.resource, qqMediaHosts)
      if (!permits(target) || !url) { throw new Error('QQ 附件不可读取') }
      return mediaResponse(await fetch(url, {redirect: 'error', signal: signal()}), reference)
    },
  })
  runtime.webhook('/prism/im/qq',signedEvents((headers,raw) => {
    const ts = headers['x-signature-timestamp'], signature = headers['x-signature-ed25519']
    // The open platform's URL-registration example sends only X-Bot-Appid.
    // An unsigned challenge may sign a plain token, never arbitrary event bytes.
    if (ts === undefined && signature === undefined && headers['x-bot-appid'] === options.appId) {
      try {
        const challenge = JSON.parse(raw.toString('utf8'))
        return challenge?.op === 13 && typeof challenge.d?.plain_token === 'string' &&
          /^[a-zA-Z0-9_-]{1,256}$/.test(challenge.d.plain_token) && /^\d{1,15}$/.test(challenge.d.event_ts) &&
          typeof challenge.d.event_ts === 'string'
      } catch { return false }
    }
    if (typeof ts !== 'string' || !/^\d{1,15}$/.test(ts) || typeof signature !== 'string' || !/^[\da-f]{128}$/i.test(signature)) return false
    return verify(null,Buffer.concat([Buffer.from(ts),raw]),publicKey,Buffer.from(signature,'hex'))
  }, async event => {
    const data = event.d as Record<string, unknown> | undefined
    if (event.op === 13) {
      if (typeof data?.plain_token !== 'string' || typeof data.event_ts !== 'string') throw new CallbackError(400)
      return {plain_token:data.plain_token, signature:sign(null,Buffer.from(data.event_ts+data.plain_token),privateKey).toString('hex')}
    }
    if (event.op === 1) return {op:11,d:data}
    if (event.op === 0 && data) {
      if (event.t === 'C2C_MESSAGE_CREATE') {
        const author = data.author as Record<string, unknown> | undefined
        const user = author?.user_openid ?? author?.id
        const text = typeof data.content === 'string' ? data.content : ''
        const raw = Array.isArray(data.attachments) ? data.attachments.slice(0, maxMediaCount + 1) : []
        const resources = mediaFields(raw.map(item => attachment(platformMediaUrl(item?.url, qqMediaHosts)?.href, {
          name: item?.filename, mimeType: item?.content_type, size: item?.size,
        })))
        if (openId(user) && !author?.bot && typeof data.id === 'string' && data.id &&
          (text.trim() || resources.attachments || resources.mediaUnavailable)) {
          const target = {user,chat:user}
          if (runtime.approvals || permits(target) || /^\/pair\s+[a-f\d]{20}$/i.test(text.trim())) {
            const timestamp = typeof data.timestamp === 'string' ? Date.parse(data.timestamp) : NaN
            if (Number.isFinite(timestamp)) remember(user, data.id, Math.min(timestamp,Date.now()))
          }
          const username = author?.username ?? author?.nickname
          await gateway.receive({...target, id: data.id, text, ...resources, ...(typeof username === 'string' && {username})})
        }
      } else if (openId(data.openid)) {
        if (event.t === 'C2C_MSG_REJECT' || event.t === 'FRIEND_DEL') runtime.state.set(key('blocked',data.openid),'yes')
        if (event.t === 'C2C_MSG_RECEIVE' || event.t === 'FRIEND_ADD') runtime.state.set(key('blocked',data.openid),'no')
      }
    }
    return {op:12,d:0}
  }))
}
