import type { ConversationView, TraceEntry } from '@dsh-prism/dsh-orchestrator'
import { GatewayState, principal } from './state.js'
import { splitText, type Destination, type Incoming, type ImTransport, type Reply } from './transport.js'

export interface ConversationService {
  view(owner: string): Promise<ConversationView>
  message(owner: string, text: string, requestId: string): Promise<ConversationView>
  selectModel(owner: string, model: string): Promise<ConversationView>
  trace(owner: string, taskId: string): Promise<TraceEntry[]>
  subscribe(owner: string, changed: (snapshot: ConversationView) => void): () => void
}

const labels = { queued: '排队中', running: '进行中', completed: '已完成', failed: '失败' }
const help = '/models 可查看可选模型，/model 序号 可切换。/tasks 可查看后台任务。'
const roleNames: Record<string, string> = { user: '用户', assistant: '助手', tool: '工具', system: '系统' }

export class ImGateway {
  private readonly watchers = new Map<string, () => void>()
  private readonly pending = new Map<string, Promise<void>>()
  private readonly inbound = new Map<string, Promise<void>>()
  private readonly dirty = new Set<string>()
  private readonly retries = new Map<string, NodeJS.Timeout>()
  private closed = false

  constructor(
    private readonly core: ConversationService,
    private readonly state: GatewayState,
    private readonly transport: ImTransport,
    private readonly onDeliveryError: () => void = () => {},
  ) {}

  start() {
    for (const target of this.state.list(this.transport.id)) {
      if (!this.transport.permits(target)) continue
      this.watch(target)
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
    const owner = principal(this.transport.id, target)
    const previous = this.state.receipt(owner, key)
    if (previous?.version === version) return
    let remote = previous?.remote
    if (remote) remote = await this.transport.edit(target, remote, reply)
    else remote = await this.transport.send(target, reply)
    this.state.delivered(owner, key, remote, version)
  }

  private async sendText(target: Destination, key: string, text: string) {
    for (const [i, part] of splitText(text).entries()) {
      await this.deliver(target, key + '/' + i, { text: part })
    }
  }

  private async flush(target: Destination) {
    const owner = principal(this.transport.id, target)
    const view = await this.core.view(owner)
    for (const item of view.messages) {
      if (item.role === 'assistant') await this.sendText(target, 'out/' + item.id, item.text)
    }
    for (const task of view.tasks) {
      const title = splitText(task.title, 800)[0] ?? '后台任务'
      const text = '任务 · ' + labels[task.status] + '\n' + title
      await this.deliver(target, 'task/' + task.id, { text, inspectTask: task.id }, text)
    }
  }

  async receive(input: Incoming): Promise<void> {
    if (this.closed || !this.transport.permits(input) || !input.text.trim()) return
    const owner = principal(this.transport.id, input)
    // Webhook transports can deliver concurrently, including the same event twice.
    const previous = this.inbound.get(owner)
    const next = (previous ?? Promise.resolve()).catch(() => {}).then(() => this.process(owner, input))
    this.inbound.set(owner, next)
    try {
      await next
    } finally {
      if (this.inbound.get(owner) === next) this.inbound.delete(owner)
    }
  }

  private async process(owner: string, input: Incoming) {
    const target = { chat: input.chat, user: input.user }
    this.state.bind(this.transport.id, target)
    this.watch(target)
    const request = 'in/' + input.id
    if (this.state.receipt(owner, request)) return
    const match = /^\/(\w+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(input.text.trim())
    if (match) {
      const reply = await this.command(owner, match[1]!, match[2]?.trim() ?? '')
      await this.sendText(target, 'cmd/' + input.id, reply)
    } else {
      await this.core.message(owner, input.text, input.id)
    }
    this.state.delivered(owner, request, 'processed')
    this.wake(target)
  }

  private async command(owner: string, name: string, arg: string): Promise<string> {
    if (name === 'models' || name === 'model') {
      const { modelId, models } = await this.core.view(owner)
      if (name === 'model' && arg) {
        const model = models.find(m => m.id === arg) ?? (/^[1-9]\d*$/.test(arg) ? models[Number(arg) - 1] : undefined)
        if (!model) return '未找到该模型。使用 /models 查看列表。'
        await this.core.selectModel(owner, model.id)
        return '当前模型为 ' + model.id
      }
      return models.map((m, i) => (i + 1) + '. ' + m.id + (m.id === modelId ? '（当前）' : '') +
        '\n' + m.description).join('\n\n') + '\n\n使用 /model 序号 切换。'
    }
    if (name === 'tasks') {
      const { tasks } = await this.core.view(owner)
      return tasks.length ? tasks.map(t => labels[t.status] + ' · ' + t.title + '\n/inspect ' + t.id).join('\n\n') : '暂无后台任务。'
    }
    if (name === 'inspect') {
      const { tasks } = await this.core.view(owner)
      if (!arg || !tasks.some(t => t.id === arg)) return '此对话中没有该任务。'
      const trace = await this.core.trace(owner, arg)
      return trace.length ? '会话记录（只读）\n\n' +
        trace.map(line => (roleNames[line.role] ?? line.role) + ' · ' + line.text).join('\n\n') : '这项任务暂无会话记录。'
    }
    return help
  }

  async close() {
    this.closed = true
    for (const unwatch of this.watchers.values()) unwatch()
    for (const timer of this.retries.values()) clearTimeout(timer)
    await Promise.allSettled([...this.inbound.values(), ...this.pending.values()])
    this.watchers.clear()
    this.retries.clear()
  }
}
