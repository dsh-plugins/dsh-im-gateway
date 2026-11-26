import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { dshPath } from '@deepseek-ai/dsh-home-paths'
import { GatewayState } from './state.js'
import type { Locale } from './i18n.js'
import { channels } from './admin-config.js'
import { adminRoute } from './admin-route.js'
import { ChannelSupervisor } from './supervisor.js'
import { LoginAdmin } from './login-admin.js'
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
  managed?: boolean
  statePath?: string
  locale?: Locale
}

export function apply(ctx: Context, config: Config = {}) {
  if (!config.managed && !channels.some(channel => config[channel])) return
  const file = config.statePath ?? dshPath('data', 'prism', 'im.sqlite')
  const state = new GatewayState(file)
  const runner = new ChannelSupervisor(ctx, config, state, file)
  let login: LoginAdmin | undefined
  let unmount: (() => void) | undefined
  try {
    if (config.managed) {
      const server = ctx.get('webServer', true)
      if (!server) throw new Error('DSH Web host required for IM settings')
      login = new LoginAdmin(state, channel => runner.registered(channel))
      unmount = server.register(adminRoute({
        list: () => runner.list(), save: (channel, body) => runner.save(channel, body),
        pair: channel => ({code: state.issuePairingCode(channel), expiresAt: Date.now() + 600_000}),
        login,
      }))
    }
    for (const channel of channels) runner.start(channel)
  } catch (error) {
    unmount?.()
    void runner.close().finally(() => state.close())
    throw error
  }
  return async () => {
    unmount?.()
    await login?.close()
    await runner.close()
    state.close()
  }
}
