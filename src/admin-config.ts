import type { Config } from './index.js'
import type { GatewayState } from './state.js'

export const channels = ['telegram', 'wechat', 'feishu', 'wecom', 'qq', 'onebot', 'discord'] as const
export type Channel = typeof channels[number]
export type ChannelStatus = 'disabled' | 'starting' | 'running' | 'error'
type Fields = {allowedUserIds: string[]; appId?: string; domain?: string; botId?: string; selfId?: string; apiBase?: string}
type SecretValues = Record<string, string | null>
type Document = {revision: number; enabled: boolean; fields: Fields; secrets: SecretValues; username?: string}
export type ChannelView = Omit<Document, 'secrets'> & {
  channel: Channel; status: ChannelStatus; registered: boolean; accountId?: string; secrets: Record<string, boolean>
}

export class AdminError extends Error {
  constructor(readonly code: 'invalid' | 'conflict' | 'not_found' | 'unavailable' | 'forbidden') { super(code) }
}
export function isChannel(value: unknown): value is Channel {
  return typeof value === 'string' && channels.some(channel => channel === value)
}

const fieldsByChannel: Record<Channel, readonly (keyof Omit<Fields, 'allowedUserIds'>)[]> = {
  telegram: [], wechat: [], feishu: ['domain', 'appId'], wecom: ['botId'], qq: ['appId'],
  onebot: ['selfId', 'apiBase'], discord: [],
}
// Browser clients can replace values but cannot choose an arbitrary process environment key.
const credentialFields: Record<Channel, Record<string, [string, string]>> = {
  telegram: {token: ['tokenEnv', 'TELEGRAM_BOT_TOKEN']}, wechat: {},
  feishu: {appSecret: ['appSecretEnv', 'FEISHU_APP_SECRET']},
  wecom: {secret: ['secretEnv', 'WECOM_BOT_SECRET']}, qq: {appSecret: ['appSecretEnv', 'QQ_BOT_SECRET']},
  onebot: {accessToken: ['accessTokenEnv', 'ONEBOT_ACCESS_TOKEN'], eventSecret: ['eventSecretEnv', 'ONEBOT_EVENT_SECRET']},
  discord: {token: ['tokenEnv', 'DISCORD_BOT_TOKEN']},
}
export function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AdminError('invalid')
  return input as Record<string, unknown>
}
function clean(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw new AdminError('invalid')
  return value.trim()
}
function updateFields(channel: Channel, before: Fields, input: unknown): Fields {
  const fields = {...before}
  for (const [name, value] of Object.entries(object(input))) {
    if (name === 'allowedUserIds') {
      if (!Array.isArray(value) || value.length > 1024) throw new AdminError('invalid')
      fields.allowedUserIds = [...new Set(value.map(v => clean(v, 256)))]
      if (fields.allowedUserIds.some(user => !user)) throw new AdminError('invalid')
      continue
    }
    const key = fieldsByChannel[channel].find(key => key === name)
    if (!key) throw new AdminError('invalid')
    const text = clean(value, key === 'apiBase' ? 2048 : 256)
    if (key === 'domain' && text && !['feishu','lark'].includes(text)) throw new AdminError('invalid')
    if (key === 'selfId' && text && (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(Number(text)))) throw new AdminError('invalid')
    if (channel === 'qq' && key === 'appId' && text && !/^\d+$/.test(text)) throw new AdminError('invalid')
    if (key === 'apiBase' && text) {
      const url = URL.parse(text)
      if (!url || !['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new AdminError('invalid')
    }
    fields[key] = text
  }
  return fields
}

export class ChannelConfiguration {
  constructor(private readonly state: GatewayState, private readonly initial: Config) {}

  private key(channel: Channel) { return 'admin/channel/' + channel }

  private read(channel: Channel, raw = this.state.get(this.key(channel))): Document {
    if (raw !== undefined) return JSON.parse(raw) as Document
    const original = (this.initial[channel] ?? {}) as Record<string, unknown>
    const fields: Fields = {allowedUserIds: (original.allowedUserIds ?? original.allowedUsers ?? []) as string[]}
    for (const name of fieldsByChannel[channel]) fields[name] = String(original[name] ?? '')
    return {revision: 0, enabled: Boolean(this.initial[channel]), fields, secrets: {}}
  }

  secret(channel: Channel, field: string, secrets = this.read(channel).secrets): string | undefined {
    if (!Object.hasOwn(credentialFields[channel], field)) return
    if (Object.hasOwn(secrets, field)) return secrets[field] || undefined
    const old = this.initial[channel] as Record<string, unknown> | undefined
    if (old) {
      const [ref, fallback] = credentialFields[channel][field]
      const inherited = process.env[String(old[ref] ?? fallback)]
      if (inherited) return inherited
    }
    if (channel === 'telegram') return this.state.get('telegram/token')
  }

  view(channel: Channel, status: ChannelStatus): ChannelView {
    const {enabled, revision, fields, secrets, username} = this.read(channel)
    const registration = channel === 'feishu' || channel === 'wechat' ? this.state.get(channel + '/registration') : undefined
    const accountId = registration && (JSON.parse(registration) as {botId?: string; appId?: string})[channel === 'wechat' ? 'botId' : 'appId']
    return {channel, enabled, revision, fields, status, registered: Boolean(registration), username, accountId, secrets: Object.fromEntries(
      Object.keys(credentialFields[channel]).map(name => [name, !!this.secret(channel, name, secrets)]))}
  }

  save(channel: Channel, payload: Record<string, unknown>): void {
    const key = this.key(channel)
    const raw = this.state.get(key)
    const current = this.read(channel, raw)
    if (typeof payload.enabled !== 'boolean' || !Number.isSafeInteger(payload.revision)) throw new AdminError('invalid')
    if (payload.revision !== current.revision) throw new AdminError('conflict')
    const fields = updateFields(channel, current.fields, payload.fields)
    const username = payload.username === undefined ? current.username : clean(payload.username, 256)
    const updates = object(payload.secrets ?? {})
    const secrets = {...current.secrets}
    for (const [name,value] of Object.entries(updates)) {
      if (!Object.hasOwn(credentialFields[channel],name)) throw new AdminError('invalid')
      if (value === null) secrets[name] = null
      else {
        if (typeof value !== 'string' || !value || !value.trim() || value.length > 8192 || /[\x00-\x1f\x7f]/.test(value)) throw new AdminError('invalid')
        secrets[name] = value
      }
    }
    // An existing outgoing token belongs to the endpoint it was entered for.
    if (channel === 'onebot' && current.fields.apiBase && fields.apiBase !== current.fields.apiBase
        && this.secret(channel, 'accessToken', current.secrets) && !Object.hasOwn(updates, 'accessToken')) throw new AdminError('invalid')
    if (payload.enabled) {
      if (channel === 'wechat' && !this.state.get('wechat/registration')) throw new AdminError('invalid')
      if (channel === 'wecom' && !fields.botId || channel === 'qq' && !fields.appId
          || channel === 'onebot' && (!fields.selfId || !fields.apiBase)) throw new AdminError('invalid')
      const useRegistration = channel === 'feishu' && !fields.appId
      if (useRegistration) {
        const registered = this.state.get('feishu/registration')
        if (!registered || fields.domain && JSON.parse(registered).domain !== fields.domain) throw new AdminError('invalid')
      } else if (Object.keys(credentialFields[channel]).some(name => !this.secret(channel, name, secrets))) throw new AdminError('invalid')
    }
    const next: Document = {revision: current.revision + 1, enabled: payload.enabled, fields, secrets, username: username || undefined}
    if (!this.state.compareAndSet(key, raw, JSON.stringify(next))) throw new AdminError('conflict')
  }

  registered(channel: 'wechat' | 'feishu'): void {
    const key = this.key(channel)
    const raw = this.state.get(key)
    const doc = this.read(channel, raw)
    if (channel === 'feishu') {
      const saved = this.state.get('feishu/registration')
      if (!saved) throw new AdminError('unavailable')
      const domain = JSON.parse(saved).domain
      if (domain !== 'feishu' && domain !== 'lark') throw new AdminError('unavailable')
      doc.fields = {...doc.fields, appId: '', domain: ''}
      doc.secrets = {...doc.secrets, appSecret: null}
    }
    doc.revision++
    if (!this.state.compareAndSet(key, raw, JSON.stringify(doc))) throw new AdminError('conflict')
  }

  options(channel: Channel): Config[Channel] {
    const doc = this.read(channel)
    if (!doc.enabled) return
    if (doc.revision === 0) return this.initial[channel]
    return Object.fromEntries(Object.entries(doc.fields).filter(([,value]) => value !== ''))
  }
}
