import * as Lark from '@larksuiteoapi/node-sdk'
import { channelSecret, type ChannelRuntime } from './runtime.js'
import type { GatewayState } from './state.js'
import type { Destination, ImTransport, Incoming, Reply } from './transport.js'

export interface FeishuConfig {
  domain?: 'feishu' | 'lark'
  appId?: string
  appSecretEnv?: string
  allowedUserIds?: string[]
  allowedUsers?: string[]
}

type Registration = { appId: string; appSecret: string; domain: 'feishu' | 'lark'; openId?: string }
const registrationKey = 'feishu/registration'

/** The SDK polls Feishu's app registration endpoint and switches domains for Lark tenants. */
export async function loginFeishu(
  state: Pick<GatewayState, 'set'>, onCode: (url: string, expireIn?: number) => void, signal?: AbortSignal,
  register: typeof Lark.registerApp = Lark.registerApp,
): Promise<Omit<Registration, 'appSecret'>> {
  signal?.throwIfAborted()
  let domain: Registration['domain'] = 'feishu'
  const result = await register({
    createOnly: true, source: 'dsh-prism', signal,
    appPreset: { name: 'DSH Prism' },
    addons: {
      preset: false,
      scopes: { tenant: ['im:message.p2p_msg:readonly', 'im:message:send_as_bot', 'im:message:update'] },
      events: { items: { tenant: ['im.message.receive_v1'] } },
    },
    onQRCodeReady: ({ url, expireIn }) => onCode(url, expireIn),
    onStatusChange: event => { if (event.status === 'domain_switched') domain = 'lark' },
  })
  signal?.throwIfAborted()
  if (!result.client_id || !result.client_secret) throw new Error('Incomplete Feishu app registration')
  const info = { appId: result.client_id, domain: result.user_info?.tenant_brand ?? domain, openId: result.user_info?.open_id }
  state.set(registrationKey, JSON.stringify({ ...info, appSecret: result.client_secret }))
  return info
}

function credentials(config: FeishuConfig, runtime: ChannelRuntime): Registration {
  if (config.appId || config.appSecretEnv) {
    const secret = channelSecret(runtime, 'appSecret', config.appSecretEnv ?? 'FEISHU_APP_SECRET')
    if (!config.appId || !secret) throw new Error('Feishu needs an appId and an app secret')
    return { appId: config.appId, appSecret: secret, domain: config.domain ?? 'feishu' }
  }
  const stored = runtime.state.get(registrationKey)
  if (!stored) throw new Error('Feishu requires app credentials or prism-im login feishu')
  const saved = JSON.parse(stored) as Registration
  if (!saved.appId || !saved.appSecret || !['feishu', 'lark'].includes(saved.domain)) throw new Error('Invalid saved Feishu credentials')
  if (config.domain && config.domain !== saved.domain) throw new Error('Saved Feishu registration uses another domain')
  return saved
}

type ChatEvent = {
  app_id?: string
  sender?: { sender_type?: string; sender_id?: { open_id?: string } }
  message?: { chat_type?: string; message_type?: string; message_id?: string; content?: string }
}

export function decodeFeishu(event: ChatEvent, appId: string): Incoming | undefined {
  const user = event.sender?.sender_id?.open_id
  const message = event.message
  if ((event.app_id && event.app_id !== appId) || event.sender?.sender_type !== 'user' || !user ||
    message?.chat_type !== 'p2p' || message.message_type !== 'text' || !message.message_id || !message.content) return
  let text: unknown
  try { text = JSON.parse(message.content)?.text } catch { return }
  if (typeof text === 'string' && text.trim()) return { user, chat: user, id: message.message_id, text }
}

function content(reply: Reply) {
  if (!reply.inspectTask) return { msg_type: 'text', content: JSON.stringify({ text: reply.text }) }
  return {
    msg_type: 'interactive', content: JSON.stringify({
      schema: '2.0', config: { update_multi: true },
      body: { elements: [{
        tag: 'collapsible_panel', expanded: false,
        header: { title: { tag: 'plain_text', content: reply.text.replace(/\n+/gu, ' · ') } },
        elements: [{ tag: 'markdown', content: '`/inspect ' + reply.inspectTask + '`' }],
      }] },
    }),
  }
}

export class FeishuTransport implements ImTransport {
  constructor(readonly id: string, private readonly client: Lark.Client, private readonly access: (d: Destination) => boolean) {}

  permits(target: Destination): boolean { return target.chat === target.user && this.access(target) }

  async send(target: Destination, reply: Reply): Promise<string> {
    if (!this.permits(target)) throw new Error('Unauthorized Feishu recipient')
    const response = await this.client.im.message.create({
      params: { receive_id_type: 'open_id' },
      data: { receive_id: target.user, ...content(reply), ...(reply.deliveryId ? { uuid: reply.deliveryId.slice(0, 40) } : {}) },
    })
    if (response.code !== 0 || !response.data?.message_id) throw new Error('Feishu send failed')
    return response.data.message_id
  }

  async edit(target: Destination, messageId: string, reply: Reply): Promise<string> {
    if (!this.permits(target)) throw new Error('Unauthorized Feishu recipient')
    const data = content(reply)
    const path = { message_id: messageId }
    const response = reply.inspectTask
      ? await this.client.im.message.patch({ path, data: { content: data.content } })
      : await this.client.im.message.update({ path, data })
    if (response.code !== 0) throw new Error('Feishu update failed')
    return messageId
  }
}

export async function startFeishu(config: FeishuConfig, runtime: ChannelRuntime): Promise<void> {
  runtime.signal.throwIfAborted()
  const auth = credentials(config, runtime)
  const id = 'feishu/' + auth.domain + '/' + auth.appId
  const users = [...config.allowedUserIds ?? config.allowedUsers ?? [], ...auth.openId ? [auth.openId] : []]
  // Some SDK clients fall back to info at the fatal level. Keep credential-bearing HTTP objects off host logs.
  const logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {} }
  const options = { appId: auth.appId, appSecret: auth.appSecret, domain: auth.domain === 'lark' ? Lark.Domain.Lark : Lark.Domain.Feishu,
    logger, loggerLevel: Lark.LoggerLevel.fatal }
  const client = new Lark.Client(options)
  const gateway = runtime.mount(new FeishuTransport(id, client, runtime.access(id, users)))
  const readUsername = async (user: string) => {
    try {
      const result = await client.contact.user.get({path: {user_id: user}, params: {user_id_type: 'open_id'}})
      return result.code === 0 ? result.data?.user?.name : undefined
    } catch {
      if (!runtime.signal.aborted) {
        runtime.warn('Could not retrieve the Feishu user name for an IM approval')
      }
    }
  }
  const dispatcher = new Lark.EventDispatcher({ logger, loggerLevel: Lark.LoggerLevel.fatal }).register({
    'im.message.receive_v1': async event => {
      const input = decodeFeishu(event, auth.appId)
      if (input && !runtime.signal.aborted) {
        await gateway.receive(input, readUsername)
      }
    },
  })
  const ws = new Lark.WSClient({ ...options, onError: () => runtime.warn('Feishu WebSocket failed') })
  const close = () => ws.close({ force: true })
  runtime.signal.addEventListener('abort', close, { once: true })
  try { await ws.start({ eventDispatcher: dispatcher }) } catch {
    close()
    runtime.signal.removeEventListener('abort', close)
    throw new Error('Feishu WebSocket startup failed')
  }
}
