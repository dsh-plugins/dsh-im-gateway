import { createHash } from 'node:crypto'
import type { ConversationView, TraceEntry } from '@dsh-prism/dsh-orchestrator'
import { localeOf, locales, messages, type Locale } from './i18n.js'
import { GatewayState, principal } from './state.js'
import { splitText, type Destination, type Incoming, type ImTransport, type Reply } from './transport.js'

function modelLabel(model: ConversationView['models'][number]): string {
  return 'label' in model && typeof model.label === 'string' ? model.label : model.id
}

export interface ConversationService {
  view(owner: string): Promise<ConversationView>
  message(owner: string, text: string, requestId: string, source?: {channel: string; sender?: string}): Promise<ConversationView>
  selectModel(owner: string, model: string): Promise<ConversationView>
  trace(owner: string, taskId: string): Promise<TraceEntry[]>
  subscribe(owner: string, changed: (snapshot: ConversationView) => void): () => void
  registerChannelAccess?(channelId: string, permits: (owner: string) => boolean): () => void
}

export class ImGateway {
  private readonly watchers = new Map<string, () => void>()
  private readonly pending = new Map<string, Promise<void>>()
  private readonly inbound = new Map<string, Promise<void>>()
  private readonly dirty = new Set<string>()
  private readonly retries = new Map<string, NodeJS.Timeout>()
  private readonly inputRetries = new Map<string, NodeJS.Timeout>()
  private closed = false
  private unregisterAccess?: () => void

  constructor(
    private readonly core: ConversationService,
    private readonly state: GatewayState,
    private readonly transport: ImTransport,
    private readonly onDeliveryError: () => void = () => {},
    private readonly defaultLocale: Locale = 'zh',
    private readonly options: {approvals?: boolean; channel?: string} = {},
  ) {}

  start() {
    this.unregisterAccess = this.core.registerChannelAccess?.(this.transport.id, owner => {
      if (this.closed || !owner.startsWith('im:')) {
        return false
      }
      try {
        const [channel, chat, user] = JSON.parse(owner.slice(3)) as unknown[]
        return channel === this.transport.id && typeof chat === 'string' && typeof user === 'string' &&
          this.transport.permits({chat, user})
      } catch {
        return false
      }
    })
    for (const target of this.state.list(this.transport.id)) {
      if (!this.transport.permits(target)) continue
      this.watch(target)
      void this.drain(target).catch(() => {})
      this.wake(target)
    }
  }

  private watch(target: Destination) {
    const owner = principal(this.transport.id, target)
    if (this.watchers.has(owner)) return
    this.watchers.set(owner, this.core.subscribe(owner, () => this.wake(target)))
  }

  // Multiple notifications coalesce. A notification during a send forces another snapshot.
  private wake(target: Destination) {
    if (this.closed) return
    const owner = principal(this.transport.id, target)
    this.dirty.add(owner)
    if (this.pending.has(owner) || this.retries.has(owner)) return
    const work = Promise.resolve().then(async () => {
      while (!this.closed && this.dirty.delete(owner)) await this.flush(target)
    }).catch(() => {
      if (this.closed) return
      this.onDeliveryError()
      this.retries.set(owner, setTimeout(() => {
        this.retries.delete(owner)
        this.wake(target)
      }, 5000).unref())
    }).finally(() => {
      this.pending.delete(owner)
      if (this.dirty.has(owner)) this.wake(target)
    })
    this.pending.set(owner, work)
  }

  private async deliver(target: Destination, key: string, reply: Reply, version = '') {
    if (this.closed || !this.transport.permits(target)) {
      return
    }
    const owner = principal(this.transport.id, target)
    const previous = this.state.receipt(owner, key)
    if (previous?.version === version) return
    reply = { ...reply, deliveryId: createHash('sha256').update(JSON.stringify([owner, key, version])).digest('hex') }
    let remote = previous?.remote
    if (remote) remote = await this.transport.edit(target, remote, reply)
    else remote = await this.transport.send(target, reply)
    this.state.delivered(owner, key, remote, version)
  }

  private async sendText(target: Destination, key: string, text: string) {
    for (const [i, part] of splitText(text, this.transport.maxTextLength ?? 4000, this.transport.maxTextBytes).entries()) {
      await this.deliver(target, key + '/' + i, { text: part })
    }
  }

  private language(owner: string): Locale {
    return localeOf(this.state.get('language/' + owner)) ?? localeOf(this.state.get('detected/' + owner)) ?? this.defaultLocale
  }

  private async flush(target: Destination) {
    if (!this.transport.permits(target)) return
    const owner = principal(this.transport.id, target)
    const view = await this.core.view(owner)
    for (const item of view.messages) {
      if (item.role === 'assistant') await this.sendText(target, 'out/' + item.id, item.text)
    }
    const m = messages(this.language(owner))
    for (const task of view.tasks) {
      const title = splitText(task.title, 800)[0] ?? m.task
      const text = m.task + ' · ' + m[task.status] + '\n' + title
      await this.deliver(target, 'task/' + task.id, { text, inspectTask: task.id, inspectLabel: m.inspect }, text)
    }
  }

  async receive(input: Incoming, readUsername?: (user: string) => Promise<string | undefined>): Promise<void> {
    if (this.closed || !input.text.trim()) return
    if (!this.transport.permits(input)) {
      const code = /^\/pair\s+([a-f0-9]{20})$/i.exec(input.text.trim())?.[1]
      if (!code || !this.state.claim(this.transport.id, input, code) || !this.transport.permits(input)) {
        if (this.options.approvals && !/^\/pair(?:\s|$)/i.test(input.text.trim()) && input.text.length <= 32_000) {
          const id = this.state.requestApproval(this.transport.id, input)
          if (id && !input.username && readUsername) {
            void readUsername(input.user).then(username => {
              if (!this.closed && username) {
                this.state.nameApproval(id, username)
              }
            }).catch(this.onDeliveryError)
          }
        }
        return
      }
    }
    // A pushed frame may be the platform's only delivery. Persist it before the first await.
    const saved = /^\/pair(?:\s|$)/i.test(input.text) ? { ...input, text: '/pair' } : input
    this.state.enqueue(this.transport.id, saved)
    await this.drain(input)
  }

  resume(target: Destination) {
    if (!this.closed) {
      void this.drain(target).catch(this.onDeliveryError)
    }
  }

  private async drain(target: Destination) {
    const owner = principal(this.transport.id, target)
    const previous = this.inbound.get(owner)
    const next = (previous ?? Promise.resolve()).catch(() => {}).then(async () => {
      if (!this.transport.permits(target)) return
      for (const item of this.state.pendingInputs(owner)) await this.process(owner, item)
    })
    this.inbound.set(owner, next)
    try {
      await next
    } catch (error) {
      if (!this.closed && !this.inputRetries.has(owner)) {
        this.inputRetries.set(owner, setTimeout(() => {
          this.inputRetries.delete(owner)
          void this.drain(target).catch(() => {})
        }, 5000).unref())
      }
      throw error
    } finally {
      if (this.inbound.get(owner) === next) this.inbound.delete(owner)
    }
  }

  private async process(owner: string, input: Incoming) {
    const target = { chat: input.chat, user: input.user }
    const detected = localeOf(input.locale)
    if (detected) this.state.set('detected/' + owner, detected)
    this.watch(target)
    const match = /^\/(\w+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(input.text.trim())
    if (match) {
      const reply = await this.command(owner, match[1]!, match[2]?.trim() ?? '')
      await this.sendText(target, 'cmd/' + input.id, reply)
    } else {
      await this.core.message(owner, input.text, input.id, {
        channel: this.options.channel ?? this.transport.id.split(/[:/]/, 1)[0],
        ...(input.username && {sender: input.username.slice(0, 120)}),
      })
    }
    this.state.finishInput(owner, input.id)
    this.wake(target)
  }

  private async command(owner: string, name: string, arg: string): Promise<string> {
    const m = messages(this.language(owner))
    if (name === 'pair') return m.paired
    if (name === 'language') {
      const language = localeOf(arg)
      if (!language) return m.language + ' · ' + this.language(owner) + '\n/language ' + locales.join(' | ')
      this.state.set('language/' + owner, language)
      return messages(language).language + ' · ' + language
    }
    if (name === 'models' || name === 'model') {
      const { modelId, models } = await this.core.view(owner)
      if (name === 'model' && arg) {
        const model = models.find(m => m.id === arg) ?? (/^[1-9]\d*$/.test(arg) ? models[Number(arg) - 1] : undefined)
        if (!model) return m.noModel
        await this.core.selectModel(owner, model.id)
        return m.currentModel + ' ' + modelLabel(model)
      }
      return models.map((model, i) => (i + 1) + '. ' + modelLabel(model) + (model.id === modelId ? ' (' + m.selected + ')' : '') +
        '\n' + model.description).join('\n\n') + '\n\n' + m.modelHint
    }
    if (name === 'tasks') {
      const { tasks } = await this.core.view(owner)
      return tasks.length ? tasks.map(t => m[t.status] + ' · ' + t.title + '\n/inspect ' + t.id).join('\n\n') : m.noTasks
    }
    if (name === 'inspect') {
      const { tasks } = await this.core.view(owner)
      if (!arg || !tasks.some(t => t.id === arg)) return m.missingTask
      const trace = await this.core.trace(owner, arg)
      return trace.length ? m.trace + '\n\n' +
        trace.map(line => (['user', 'assistant', 'tool', 'system'].includes(line.role) ? m[line.role as 'user' | 'assistant' | 'tool' | 'system'] : line.role) + ' · ' + line.text).join('\n\n') : m.noTrace
    }
    return m.help + '\n/language ' + locales.join(' | ')
  }

  async close() {
    this.closed = true
    this.unregisterAccess?.()
    for (const unwatch of this.watchers.values()) unwatch()
    for (const timers of [this.retries, this.inputRetries]) {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
    }
    await Promise.allSettled([...this.inbound.values(), ...this.pending.values()])
    this.watchers.clear()
  }
}
