import { dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Config } from './index.js'
import { ImGateway, type ConversationService } from './gateway.js'
import type { ApprovalDecision, GatewayState } from './state.js'
import type { ChannelRuntime } from './runtime.js'
import type { FeishuCredentials } from './feishu.js'
import { localeOf } from './i18n.js'
import { AdminError, channels, ChannelConfiguration, type Channel, type ChannelStatus } from './admin-config.js'

type Starters = {[K in Channel]: (options: NonNullable<Config[K]>, runtime: ChannelRuntime) => Promise<void>}
const adapters: Starters = {
  telegram: async (config, rt) => (await import('./telegram.js')).startTelegram(config, rt),
  wechat: async (config, rt) => (await import('./channels/wechat.js')).startWechat(config, rt),
  feishu: async (config, rt) => (await import('./feishu.js')).startFeishu(config, rt),
  wecom: async (config, rt) => (await import('./wecom.js')).startWecom(config, rt),
  qq: async (config, rt) => (await import('./channels/qq.js')).startQQ(config, rt),
  onebot: async (config, rt) => (await import('./channels/onebot.js')).startOneBot(config, rt),
  discord: async (config, rt) => (await import('./channels/discord.js')).startDiscord(config, rt),
}
interface ActiveChannel {
  status: ChannelStatus
  stop: AbortController
  gateways: Map<string, ImGateway>
  routes: (() => void)[]
  worker: Promise<void>
}

export class ChannelSupervisor {
  readonly configuration: ChannelConfiguration
  private active = new Map<Channel, ActiveChannel>()
  private pending = new Map<Channel, Promise<void>>()
  private readonly nicknameAbort = new AbortController()
  private nickname?: {auth: FeishuCredentials; expiresAt: number; result: Promise<string>}
  private closed = false

  constructor(private readonly ctx: Context, private readonly config: Config, private readonly state: GatewayState,
    private readonly file: string, private readonly starters = adapters) {
    this.configuration = new ChannelConfiguration(state, config)
  }

  view(channel: Channel) {
    return this.configuration.view(channel, this.active.get(channel)?.status ?? 'disabled')
  }

  list() { return Promise.all(channels.map(channel => channel === 'feishu' ? this.feishuView() : this.view(channel))) }

  private lookupNickname(auth: FeishuCredentials, refresh = false): Promise<string> {
    const cached = this.nickname
    if (!refresh && cached && cached.expiresAt > Date.now() && cached.auth.appId === auth.appId
        && cached.auth.appSecret === auth.appSecret && cached.auth.domain === auth.domain) {
      return cached.result
    }
    const result = import('./feishu.js').then(({lookupFeishuNickname}) => lookupFeishuNickname(auth, this.nicknameAbort.signal))
    this.nickname = {auth, expiresAt: Date.now() + 60_000, result}
    return result
  }

  private async feishuView() {
    const binding = this.configuration.feishuBinding()
    let nickname: string | undefined
    if (binding?.appSecret) {
      try {
        nickname = await this.lookupNickname({appId: binding.appId, domain: binding.domain, appSecret: binding.appSecret})
      } catch {
        if (this.nicknameAbort.signal.aborted) {
          throw new AdminError('unavailable')
        }
      }
    }
    const view = this.view('feishu')
    if (nickname && view.feishu && view.feishu.appId === binding?.appId && view.feishu.domain === binding.domain) {
      view.feishu.nickname = nickname
    }
    return view
  }

  decideApproval(id: string, decision: ApprovalDecision) {
    const result = this.state.decideApproval(id, decision)
    if (result && result !== 'conflict' && decision === 'approve') {
      for (const channel of this.active.values()) {
        channel.gateways.get(result.channel)?.resume(result.target)
      }
    }
    return result === 'conflict' ? result : Boolean(result)
  }

  async save(channel: Channel, request: Record<string, unknown>) {
    await this.configuration.save(channel, request, async auth => {
      try {
        await this.lookupNickname(auth, true)
      } catch {
        throw new AdminError(this.nicknameAbort.signal.aborted ? 'unavailable' : 'invalid')
      }
    })
    await this.reload(channel)
    return channel === 'feishu' ? this.feishuView() : this.view(channel)
  }

  async registered(channel: 'wechat' | 'feishu') {
    this.configuration.registered(channel)
    await this.reload(channel)
  }

  reload(channel: Channel): Promise<void> {
    const previous = this.pending.get(channel) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(async () => {
      await this.stop(channel)
      if (!this.closed) this.start(channel)
    })
    this.pending.set(channel, next)
    const clear = () => { if (this.pending.get(channel) === next) this.pending.delete(channel) }
    void next.then(clear, clear)
    return next
  }

  start<K extends Channel>(channel: K): void {
    const options = (this.config.managed ? this.configuration.options(channel) : this.config[channel]) as NonNullable<Config[K]> | undefined
    if (!options || this.closed) return
    const task: ActiveChannel = {status: 'starting', stop: new AbortController(), gateways: new Map(), routes: [], worker: Promise.resolve()}
    this.active.set(channel, task)
    const signal = task.stop.signal
    const log = this.ctx.logger('dsh-im-gateway')
    const runtime: ChannelRuntime = {
      state: this.state, directory: dirname(this.file), signal, approvals: this.config.managed,
      ...(this.config.managed && {readSecret: field => this.configuration.secret(channel, field)}),
      warn: message => log.warn(message),
      access: (id, users) => {
        const allowed = new Set(users)
        return target => !signal.aborted && (allowed.has(target.user) || this.state.paired(id, target))
      },
      mount: (transport, status = 'running') => {
        signal.throwIfAborted()
        if (task.gateways.has(transport.id)) throw new Error('Duplicate IM transport')
        const gateway = new ImGateway(this.ctx.get('prism', true) as ConversationService, this.state, transport,
          () => log.warn('IM delivery pending: ' + channel), localeOf(this.config.locale) ?? 'zh',
          {approvals: this.config.managed, channel})
        task.gateways.set(transport.id, gateway)
        gateway.start()
        task.status = status
        return gateway
      },
      connectionStatus: status => {
        if (!signal.aborted) {
          task.status = status
        }
      },
      webhook: (path, handler) => {
        signal.throwIfAborted()
        if (!['/prism/im/qq', '/prism/im/onebot'].includes(path)) throw new Error('Invalid IM callback route')
        const server = this.ctx.get('webServer', true)
        if (!server) throw new Error('DSH Web host required')
        task.routes.push(server.register({kind: 'exact', path, auth: 'anonymous', handler}))
      },
    }
    task.worker = Promise.resolve().then(() => {
      signal.throwIfAborted()
      return this.starters[channel](options, runtime)
    }).then(() => {
      if (channel === 'wechat' && !signal.aborted) throw new Error('WeChat polling ended')
    }).catch(async () => {
      if (signal.aborted) return
      task.status = 'error'
      log.error('IM channel %s stopped; check its credentials and configuration.', channel)
      await this.release(task)
    })
  }

  private async release(task: ActiveChannel) {
    task.stop.abort()
    for (const dispose of task.routes.splice(0)) dispose()
    const gateways = [...task.gateways.values()]
    task.gateways.clear()
    await Promise.allSettled(gateways.map(gateway => gateway.close()))
  }

  private async stop(channel: Channel) {
    const task = this.active.get(channel)
    if (!task) return
    await this.release(task)
    await task.worker
    this.active.delete(channel)
  }

  async close() {
    this.closed = true
    this.nicknameAbort.abort()
    await Promise.allSettled([...this.pending.values()])
    await Promise.allSettled(channels.map(channel => this.stop(channel)))
  }
}
