import { dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { dshPath } from '@deepseek-ai/dsh-home-paths'
import { ImGateway, type ConversationService } from './gateway.js'
import { GatewayState } from './state.js'
import { localeOf, type Locale } from './i18n.js'
import type { ChannelRuntime } from './runtime.js'
import type { TelegramConfig } from './telegram.js'
import type { WechatConfig } from './channels/wechat.js'
import type { FeishuConfig } from './feishu.js'
import type { WecomConfig } from './wecom.js'
import type { QQConfig } from './channels/qq.js'
import type { OneBotConfig } from './channels/onebot.js'
import type { DiscordConfig } from './channels/discord.js'

export { ImGateway, type ConversationService } from './gateway.js'
export { GatewayState, principal } from './state.js'
export { TelegramTransport } from './telegram.js'
export { loginWechat } from './channels/wechat.js'
export type { ChannelRuntime } from './runtime.js'
export type { ImTransport, Incoming, Destination, Reply } from './transport.js'

export const name = 'dsh-im-gateway'
export const inject = ['prism']

export interface Config {
  telegram?: TelegramConfig
  wechat?: WechatConfig
  feishu?: FeishuConfig
  wecom?: WecomConfig
  qq?: QQConfig
  onebot?: OneBotConfig
  discord?: DiscordConfig
  statePath?: string
  locale?: Locale
}

export function apply(ctx: Context, config: Config = {}) {
  if (![config.telegram, config.wechat, config.feishu, config.wecom, config.qq, config.onebot, config.discord].some(Boolean)) return
  const stop = new AbortController()
  const file = config.statePath ?? dshPath('data', 'prism', 'im.sqlite')
  const state = new GatewayState(file)
  const log = ctx.logger(name)
  const gateways = new Map<string, ImGateway>()
  const workers: Promise<void>[] = []
  const disposers: (() => void)[] = []
  const runtime: ChannelRuntime = {
    directory: dirname(file), signal: stop.signal, state, warn: text => log.warn(text),
    access(channel, allowedUsers) {
      const configured = new Set(allowedUsers)
      return target => configured.has(target.user) || state.paired(channel, target)
    },
    mount(transport) {
      stop.signal.throwIfAborted()
      if (gateways.has(transport.id)) throw new Error('Duplicate IM channel')
      const gateway = new ImGateway(ctx.get('prism', true) as ConversationService, state, transport,
        () => log.warn('IM delivery pending: ' + transport.id.split('/')[0]),
        localeOf(config.locale) ?? 'zh')
      gateways.set(transport.id, gateway)
      gateway.start()
      return gateway
    },
    webhook(path, handler) {
      if (!['/prism/im/qq', '/prism/im/onebot'].includes(path)) throw new Error('Invalid IM callback route')
      const server = ctx.get('webServer', true)
      if (!server) throw new Error('A DSH Web host is required for IM callbacks')
      disposers.push(server.register({ kind: 'exact', path, auth: 'anonymous', handler }))
    },
  }
  function launch<T>(name: string, value: T | undefined, start: (options: T) => Promise<void>) {
    if (!value) return
    workers.push(start(value).catch(error => {
      if (!stop.signal.aborted) log.error('IM channel %s stopped (%s); check its credentials and configuration.',
        name, error instanceof Error ? error.name : 'error')
    }))
  }
  launch('telegram', config.telegram, async opt => (await import('./telegram.js')).startTelegram(opt, runtime))
  launch('wechat', config.wechat, async opt => (await import('./channels/wechat.js')).startWechat(opt, runtime))
  launch('feishu', config.feishu, async opt => (await import('./feishu.js')).startFeishu(opt, runtime))
  launch('wecom', config.wecom, async opt => (await import('./wecom.js')).startWecom(opt, runtime))
  launch('qq', config.qq, async opt => (await import('./channels/qq.js')).startQQ(opt, runtime))
  launch('onebot', config.onebot, async opt => (await import('./channels/onebot.js')).startOneBot(opt, runtime))
  launch('discord', config.discord, async opt => (await import('./channels/discord.js')).startDiscord(opt, runtime))
  return async () => {
    for (const dispose of disposers) dispose()
    stop.abort()
    await Promise.allSettled(workers)
    await Promise.all([...gateways.values()].map(gateway => gateway.close()))
    state.close()
  }
}
