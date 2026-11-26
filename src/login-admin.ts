import { randomUUID } from 'node:crypto'
import { AdminError } from './admin-config.js'
import { loginWechat } from './channels/wechat.js'
import { GatewayState } from './state.js'

type Channel = 'wechat' | 'feishu'
type Status = 'starting' | 'waiting' | 'code' | 'complete' | 'cancelled' | 'expired' | 'error'
export interface LoginView { loginId: string; channel: Channel; status: Status; url?: string; expiresAt: number }
interface Session {
  view: LoginView
  controller: AbortController
  timer?: NodeJS.Timeout
  code?: PromiseWithResolvers<string>
}
type Driver = (staging: GatewayState, showQr: (url: string, expireIn?: number) => void, askCode: () => Promise<string>, signal: AbortSignal) => Promise<unknown>
interface Options { drivers?: Partial<Record<Channel, Driver>>; timeoutMs?: number }
const defaults: Record<Channel, Driver> = {
  wechat: loginWechat,
  feishu: async (staging, showQr, _askCode, signal) => (await import('./feishu.js')).loginFeishu(staging, showQr, signal),
}
const trustedQrHosts = {
  wechat: /(^|\.)(weixin\.qq\.com|wechat\.com)$/,
  feishu: /(^|\.)(feishu\.cn|larksuite\.com)$/,
}

function pending(status: Status) { return status === 'starting' || status === 'waiting' || status === 'code' }

function expired(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'expired_token'
    || error instanceof Error && (error.name === 'TimeoutError' || error.message === 'iLink login QR expired')
}

/** The host owns provider polling. The settings UI sees only the QR challenge and a short-lived handle. */
export class LoginAdmin {
  private readonly sessions = new Map<Channel, Session>()
  private readonly workers = new Set<Promise<void>>()
  private closed = false

  constructor(private readonly state: GatewayState, private readonly onComplete: (channel: Channel) => Promise<void> | void,
    private readonly options: Options = {}) {}

  private finish(session: Session, status: Status) {
    if (!pending(session.view.status)) return
    session.view.status = status
    delete session.view.url
    clearTimeout(session.timer)
    if (status !== 'complete') {
      session.controller.abort()
      session.code?.reject(session.controller.signal.reason)
    }
    delete session.code
  }

  private checkDeadline(session: Session) {
    if (Date.now() >= session.view.expiresAt) this.finish(session, 'expired')
  }

  private armDeadline(session: Session, expiresAt: number) {
    clearTimeout(session.timer)
    session.view.expiresAt = expiresAt
    this.checkDeadline(session)
    if (!pending(session.view.status)) return
    session.timer = setTimeout(() => this.finish(session, 'expired'), expiresAt - Date.now())
    session.timer.unref()
  }

  private async poll(session: Session) {
    const { channel } = session.view
    const key = channel + '/registration'
    // The CLI drivers persist before resolving. Keep late successes from a cancelled
    // attempt out of the live store, including when the provider ignores cancellation.
    const staging = new GatewayState(':memory:')
    const signal = session.controller.signal
    try {
      const previous = this.state.get(key)
      if (previous !== undefined) staging.set(key, previous)
      const driver = this.options.drivers?.[channel] ?? defaults[channel]
      await driver(staging, (raw, expireIn) => {
        signal.throwIfAborted()
        if (typeof expireIn === 'number' && Number.isFinite(expireIn)) {
          this.armDeadline(session, Math.min(session.view.expiresAt, Date.now() + Math.max(0, expireIn) * 1000))
        }
        this.checkDeadline(session)
        signal.throwIfAborted()
        const url = new URL(raw)
        if (url.protocol !== 'https:' || url.username || url.password || url.port || !trustedQrHosts[channel].test(url.hostname)) {
          throw new Error('Unexpected provider QR address')
        }
        session.view.status = 'waiting'
        session.view.url = url.href
      }, () => {
        this.checkDeadline(session)
        signal.throwIfAborted()
        if (channel !== 'wechat' || session.code) throw new Error('Unexpected verification prompt')
        session.view.status = 'code'
        session.code = Promise.withResolvers<string>()
        return session.code.promise
      }, signal)
      this.checkDeadline(session)
      signal.throwIfAborted()
      const registration = staging.get(key)
      if (!registration || this.state.get(key) !== previous) throw new Error('Registration was missing or changed')
      this.state.set(key, registration)
      this.finish(session, 'complete')
      await this.onComplete(channel)
    } catch (error) {
      if (session.view.status === 'complete') session.view.status = 'error'
      else this.finish(session, expired(error) ? 'expired' : 'error')
    } finally {
      staging.close()
    }
  }

  async execute(body: {op: string; channel: string; loginId?: string; code?: string}): Promise<LoginView> {
    if (this.closed) throw new AdminError('unavailable')
    const channel = body.channel
    if (channel !== 'wechat' && channel !== 'feishu') throw new AdminError('invalid')
    let session = this.sessions.get(channel)
    if (session) this.checkDeadline(session)
    if (body.op === 'loginStart') {
      // Repeated clicks and a retry after a lost response share the active challenge.
      if (session && pending(session.view.status)) return { ...session.view }
      const timeout = this.options.timeoutMs ?? (channel === 'wechat' ? 300_000 : 600_000)
      const next: Session = {
        view: { loginId: randomUUID(), channel, status: 'starting', expiresAt: Date.now() + timeout },
        controller: new AbortController(),
      }
      this.sessions.set(channel, next)
      this.armDeadline(next, next.view.expiresAt)
      const worker = this.poll(next)
      this.workers.add(worker)
      void worker.then(() => this.workers.delete(worker), () => this.workers.delete(worker))
      return { ...next.view }
    }
    if (!['loginStatus', 'loginCode', 'loginCancel'].includes(body.op)) throw new AdminError('invalid')
    if (!session || body.loginId !== session.view.loginId) throw new AdminError('not_found')
    if (body.op === 'loginStatus') return { ...session.view }
    if (session.view.status === 'expired') throw new AdminError('not_found')
    if (body.op === 'loginCancel') {
      this.finish(session, 'cancelled')
    } else {
      if (channel !== 'wechat' || typeof body.code !== 'string' || !/^\d{1,16}$/.test(body.code)) throw new AdminError('invalid')
      if (session.view.status !== 'code' || !session.code) throw new AdminError('conflict')
      session.code.resolve(body.code)
      delete session.code
      session.view.status = 'waiting'
    }
    return { ...session.view }
  }

  async close() {
    this.closed = true
    for (const session of this.sessions.values()) this.finish(session, 'cancelled')
    await Promise.all(this.workers)
    this.sessions.clear()
  }
}
