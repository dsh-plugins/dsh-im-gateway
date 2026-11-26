import { WSClient, type TextMessage } from '@wecom/aibot-node-sdk'
import { channelSecret, type ChannelRuntime } from './runtime.js'
import type { Destination, ImTransport, Incoming, Reply } from './transport.js'

export interface WecomConfig {
  botId: string
  secretEnv?: string
  allowedUserIds?: string[]
  allowedUsers?: string[]
}

export function decodeWecom(message: Partial<TextMessage> | undefined, botId: string): Incoming | undefined {
  const user = message?.from?.userid
  const text = message?.text?.content
  if (user && message?.aibotid === botId && message.chattype === 'single' && message.msgtype === 'text' &&
    message.msgid && typeof text === 'string' && text.trim()) {
    return { user, chat: user, id: message.msgid, text }
  }
}

export class WecomTransport implements ImTransport {
  readonly maxTextBytes = 3900

  constructor(readonly id: string, private readonly client: WSClient, private readonly access: (d: Destination) => boolean) {}

  permits(target: Destination): boolean { return target.chat === target.user && this.access(target) }

  async send(target: Destination, reply: Reply): Promise<string> {
    if (!this.permits(target)) throw new Error('Unauthorized WeCom recipient')
    const content = reply.inspectTask ? reply.text + '\n\n`/inspect ' + reply.inspectTask + '`' : reply.text
    const receipt = await this.client.sendMessage(target.user, { msgtype: 'markdown', markdown: { content } })
    // aibot_send_msg returns a request acknowledgement, not an editable message identifier.
    return receipt.headers.req_id
  }

  edit(target: Destination, _receipt: string, reply: Reply): Promise<string> {
    return this.send(target, reply)
  }
}

export function startWecom(config: WecomConfig, runtime: ChannelRuntime): void {
  runtime.signal.throwIfAborted()
  const secret = channelSecret(runtime, 'secret', config.secretEnv ?? 'WECOM_BOT_SECRET')
  if (!config.botId || !secret) throw new Error('WeCom needs a botId and a bot secret')
  const id = 'wecom/' + config.botId
  const ws = new WSClient({
    botId: config.botId, secret, maxReconnectAttempts: -1,
    logger: {
      debug() {}, info() {}, warn() {},
      error() { runtime.warn('WeCom WebSocket error') },
    },
  })
  const gateway = runtime.mount(new WecomTransport(id, ws, runtime.access(id, config.allowedUserIds ?? config.allowedUsers)))
  ws.on('message.text', frame => {
    const input = decodeWecom(frame.body, config.botId)
    if (input && !runtime.signal.aborted) void gateway.receive(input).catch(() => runtime.warn('WeCom message processing failed'))
  })
  ws.on('error', () => runtime.warn('WeCom connection failed'))
  runtime.signal.addEventListener('abort', () => ws.disconnect(), { once: true })
  ws.connect()
}
