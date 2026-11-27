import { randomBytes, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { ChannelRuntime } from '../runtime.js'
import type { GatewayState } from '../state.js'
import type { Destination, ImTransport, Reply } from '../transport.js'

/** Wire format from Tencent's @tencent-weixin/openclaw-weixin 2.4.10, src/auth and src/api. */
const defaultOrigin = 'https://ilinkai.weixin.qq.com'
const registrationKey = 'wechat/registration'
interface Registration { botId: string; token: string; origin: string; user?: string }
export interface WechatConfig { allowedUserIds?: string[] }
interface WeixinMessage {
  message_id?: string
  message_type?: number
  from_user_id?: string
  to_user_id?: string
  group_id?: string
  context_token?: string
  item_list?: { type: number; text_item?: { text?: string } }[]
}

function trustedOrigin(candidate: string): string {
  const url = new URL(candidate)
  if (url.protocol !== 'https:' || url.port || url.username || url.password ||
      !/(^|\.)(weixin\.qq\.com|wechat\.com)$/.test(url.hostname)) throw new Error('Invalid iLink service origin')
  return url.origin
}

function registration(state: GatewayState): Registration | undefined {
  const saved = state.get(registrationKey)
  return saved ? JSON.parse(saved) as Registration : undefined
}

async function call<T>(origin: string, endpoint: string, signal: AbortSignal, request: typeof fetch,
  body?: object, token?: string, timeout = 35_000): Promise<T> {
  const headers: Record<string, string> = { 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': '132106' }
  if (body) Object.assign(headers, {
    'Content-Type': 'application/json', AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64'),
  })
  if (token) headers.Authorization = 'Bearer ' + token
  const result = await request(new URL('/ilink/bot/' + endpoint, trustedOrigin(origin)), {
    method: body ? 'POST' : 'GET', headers, body: body && JSON.stringify(body),
    signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]), redirect: 'error',
  })
  if (!result.ok) throw new Error('iLink HTTP ' + result.status)
  // iLink sends uint64 message_id as an unquoted JSON number. Preserve its original decimal spelling.
  const data = JSON.parse(await result.text(), (key: string, value: unknown, ctx?: { source?: string }) =>
    key === 'message_id' && typeof value === 'number' ? ctx?.source ?? String(value) : value)
  if ((data.ret && data.ret !== 0) || (data.errcode && data.errcode !== 0)) {
    throw new Error('iLink error ' + Number(data.errcode || data.ret))
  }
  return data as T
}

interface LoginResult {
  status: string
  redirect_host?: string
  bot_token?: string
  ilink_bot_id?: string
  baseurl?: string
  ilink_user_id?: string
}

export async function loginWechat(state: GatewayState, onQr: (url: string) => void,
  verify: () => Promise<string>, signal: AbortSignal, request: typeof fetch = fetch): Promise<{ botId: string }> {
  const saved = registration(state)
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(5 * 60_000)])
  for (let attempt = 0; attempt < 3; attempt++) {
    const qr = await call<{qrcode: string; qrcode_img_content: string}>(defaultOrigin, 'get_bot_qrcode?bot_type=3',
      deadline, request, { local_token_list: saved ? [saved.token] : [] })
    if (!qr.qrcode || !qr.qrcode_img_content) throw new Error('iLink returned no login QR')
    if (new URL(qr.qrcode_img_content).protocol !== 'https:') throw new Error('Invalid iLink login URL')
    onQr(qr.qrcode_img_content)
    let origin = defaultOrigin
    let code = ''
    while (!deadline.aborted) {
      const query = new URLSearchParams({ qrcode: qr.qrcode })
      if (code) query.set('verify_code', code)
      let result: LoginResult
      try {
        result = await call<LoginResult>(origin, 'get_qrcode_status?' + query, deadline, request)
      } catch (error) {
        if (!(error instanceof Error && error.name === 'TimeoutError') || deadline.aborted) throw error
        continue
      }
      if (result.status === 'confirmed') {
        if (!result.bot_token || !result.ilink_bot_id) throw new Error('iLink did not issue account credentials')
        state.set(registrationKey, JSON.stringify({
          token: result.bot_token, botId: result.ilink_bot_id, user: result.ilink_user_id,
          origin: trustedOrigin(result.baseurl ?? origin),
        } satisfies Registration))
        return { botId: result.ilink_bot_id }
      }
      if (result.status === 'binded_redirect' && saved) return { botId: saved.botId }
      if (result.status === 'expired') break
      if (result.status === 'need_verifycode') { code = (await verify()).trim(); continue }
      if (result.status === 'scaned_but_redirect' && result.redirect_host) {
        origin = trustedOrigin('https://' + result.redirect_host)
        continue
      }
      if (result.status !== 'scaned' && result.status !== 'wait') throw new Error('iLink login stopped: ' + result.status)
      code = ''
      await delay(500, undefined, { signal: deadline })
    }
    deadline.throwIfAborted()
  }
  throw new Error('iLink login QR expired')
}

export async function startWechat(options: WechatConfig, runtime: ChannelRuntime, request: typeof fetch = fetch): Promise<void> {
  const saved = registration(runtime.state)
  if (!saved) throw new Error('Run prism-im login wechat first')
  const account: Registration = saved
  let expired = false
  const channel = 'wechat/' + account.botId
  const users = [...(options.allowedUserIds ?? [])]
  if (!runtime.approvals && account.user) {
    users.push(account.user)
  }
  const allowed = runtime.access(channel, users)
  const permits = (target: Destination) => target.chat === target.user && allowed(target)
  const contextKey = (user: string) => channel + '/context/' + user
  const base_info = { channel_version: '2.4.10' }
  async function send(target: Destination, reply: Reply): Promise<string> {
    if (expired) throw new Error('WeChat session expired')
    if (!permits(target)) throw new Error('Unknown WeChat recipient')
    const context = runtime.state.get(contextKey(target.user))
    if (!context) throw new Error('Waiting for WeChat conversation context')
    const clientId = reply.deliveryId ?? randomUUID()
    const text = reply.text + (reply.inspectTask ? '\n/inspect ' + reply.inspectTask : '')
    const res = await call<{ message_id?: string }>(account.origin, 'sendmessage', runtime.signal, request, {
      base_info, msg: {
        from_user_id: '', to_user_id: target.user, client_id: clientId, message_type: 2, message_state: 2,
        context_token: context, item_list: [{ type: 1, text_item: { text } }],
      },
    }, account.token)
    return res.message_id ?? clientId
  }
  const transport: ImTransport = {
    id: channel, permits, send, maxTextBytes: 3800,
    // iLink publishes text updates as new messages. Only platforms with an edit API update in place.
    edit: (target, _id, reply) => send(target, reply),
  }
  const gateway = runtime.mount(transport)
  const cursorKey = channel + '/updates'
  let timeout = 35_000
  while (!runtime.signal.aborted) {
    try {
      const updates = await call<{ msgs?: WeixinMessage[]; get_updates_buf?: string; longpolling_timeout_ms?: number }>(
        account.origin, 'getupdates', runtime.signal, request,
        { base_info, get_updates_buf: runtime.state.get(cursorKey) ?? '' }, account.token, timeout)
      for (const msg of updates.msgs ?? []) {
        if (msg.message_type !== 1 || msg.group_id || !msg.from_user_id || !msg.context_token ||
            !msg.message_id || (msg.to_user_id && msg.to_user_id !== account.botId)) continue
        const text = msg.item_list?.filter(item => item.type === 1).map(item => item.text_item?.text ?? '').join('\n')
        if (!text?.trim()) continue
        const target = { chat: msg.from_user_id, user: msg.from_user_id }
        if (!runtime.approvals && !permits(target) && !/^\/pair [0-9a-f]{20}$/i.test(text.trim())) {
          continue
        }
        runtime.state.set(contextKey(target.user), msg.context_token)
        await gateway.receive({ ...target, id: String(msg.message_id), text })
      }
      if (typeof updates.get_updates_buf === 'string') runtime.state.set(cursorKey, updates.get_updates_buf)
      if (updates.longpolling_timeout_ms) timeout = Math.max(5000, Math.min(120_000, updates.longpolling_timeout_ms + 5000))
    } catch (error) {
      if (runtime.signal.aborted) break
      if (error instanceof Error && error.name === 'TimeoutError') continue
      if (error instanceof Error && error.message === 'iLink error -14') {
        expired = true
        runtime.warn('WeChat session expired. Repeat prism-im login wechat and restart the channel.')
        return
      }
      runtime.warn('WeChat polling interrupted; retrying')
      await delay(5000, undefined, { signal: runtime.signal }).catch(() => {})
    }
  }
}
