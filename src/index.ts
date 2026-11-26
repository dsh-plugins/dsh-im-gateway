import type { Context } from '@deepseek-ai/cordis'
import { dshPath } from '@deepseek-ai/dsh-home-paths'
import { ImGateway, type ConversationService } from './gateway.js'
import { GatewayState } from './state.js'
import { TelegramTransport } from './telegram.js'

export { ImGateway, type ConversationService } from './gateway.js'
export { GatewayState, principal } from './state.js'
export { TelegramTransport } from './telegram.js'
export type { ImTransport, Incoming, Destination, Reply } from './transport.js'

export const name = 'dsh-im-gateway'
export const inject = ['prism']

export interface Config {
  telegram?: { tokenEnv?: string; allowedUserIds: string[] }
  statePath?: string
}

export function apply(ctx: Context, config: Config = {}) {
  if (!config.telegram) return
  const token = process.env[config.telegram.tokenEnv ?? 'TELEGRAM_BOT_TOKEN']
  if (!token) throw new Error('Telegram bot token environment variable is empty')
  const stop = new AbortController()
  const transport = new TelegramTransport(token, config.telegram.allowedUserIds, stop.signal)
  const state = new GatewayState(config.statePath ?? dshPath('data', 'prism', 'im.sqlite'))
  const log = ctx.logger(name)
  const gateway = new ImGateway(ctx.get('prism', true) as ConversationService, state, transport,
    () => log.warn('IM delivery pending. Retrying.'))
  gateway.start()
  const polling = transport.poll(gateway, state, () => log.warn('Telegram polling paused. Retrying.'))
  return async () => {
    stop.abort()
    await polling
    await gateway.close()
    state.close()
  }
}
