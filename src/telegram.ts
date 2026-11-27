import { setTimeout as delay } from 'node:timers/promises'
import type { ImGateway } from './gateway.js'
import { attachment, maxMediaBytes, mediaFields, mediaResponse } from './media.js'
import type { GatewayState } from './state.js'
import type { AttachmentReference, Destination, ImTransport, Incoming, Reply } from './transport.js'

import { channelSecret, type ChannelRuntime } from './runtime.js'
export interface TelegramConfig { tokenEnv?: string; allowedUserIds?: string[] }
interface User { id: number; is_bot: boolean; language_code?: string; username?: string; first_name?: string; last_name?: string }
interface Chat { type: string; id: number }
interface TelegramFile { file_id: string; file_name?: string; mime_type?: string; file_size?: number }
interface Update {
  update_id: number
  message?: {
    from?: User; chat: Chat; text?: string; caption?: string; photo?: TelegramFile[]
    video?: TelegramFile; animation?: TelegramFile; document?: TelegramFile; video_note?: TelegramFile
    voice?: unknown; audio?: unknown; sticker?: unknown
  }
  callback_query?: { id: string; from: User; message?: { chat: Chat }; data?: string }
}

interface ApiEnvelope<T> {
  ok: boolean
  result: T
  description?: string
  parameters?: { retry_after?: number }
}

class ApiError extends Error {
  constructor(readonly httpStatus: number, readonly detail: string, readonly retryAfter: number) {
    super('Telegram API request failed (' + httpStatus + ')')
  }
}

export class TelegramTransport implements ImTransport {
  readonly id: string
  private readonly allowed: Set<string>

  constructor(
    private readonly token: string,
    allowedUserIds: string[],
    private readonly signal: AbortSignal,
    private readonly request: typeof fetch = fetch,
    private readonly paired?: (target: Destination) => boolean,
    private readonly approvals = false,
  ) {
    const bot = /^(\d+):[\w-]+$/.exec(token)?.[1]
    if (!bot) throw new Error('Invalid Telegram bot token format')
    if (!Array.isArray(allowedUserIds) || allowedUserIds.some(id => !/^\d+$/.test(id))) {
      throw new Error('Configure Telegram allowedUserIds with numeric private user IDs')
    }
    this.id = 'telegram/' + bot
    this.allowed = new Set(allowedUserIds.map(String))
  }

  permits({ user, chat }: Destination) { return chat === user && (this.allowed.has(user) || !!this.paired?.({ chat, user })) }

  private async api<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const response = await this.request('https://api.telegram.org/bot' + this.token + '/' + method, {
      method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.any([this.signal, AbortSignal.timeout(35_000)]),
    })
    const result = await response.json() as ApiEnvelope<T>
    if (!response.ok || !result.ok) {
      throw new ApiError(response.status, result.description ?? '', Number(result.parameters?.retry_after) || 0)
    }
    return result.result
  }

  private payload(target: Destination, reply: Reply): Record<string, unknown> {
    if (!this.permits(target)) throw new Error('Unknown destination')
    const data = 't:' + reply.inspectTask
    const buttonFits = reply.inspectTask && Buffer.byteLength(data) <= 64
    return {
      chat_id: target.chat,
      text: reply.text + (reply.inspectTask && !buttonFits ? '\n/inspect ' + reply.inspectTask : ''),
      link_preview_options: { is_disabled: true },
      ...(buttonFits && { reply_markup: { inline_keyboard: [[{ text: reply.inspectLabel ?? '查看只读会话', callback_data: data }]] } }),
    }
  }

  async send(target: Destination, reply: Reply): Promise<string> {
    const message = await this.api<{ message_id: number }>('sendMessage', this.payload(target, reply))
    return String(message.message_id)
  }

  async edit(target: Destination, messageId: string, reply: Reply): Promise<string> {
    try {
      await this.api('editMessageText', { ...this.payload(target, reply), message_id: Number(messageId) })
    } catch (error) {
      if (!(error instanceof ApiError) || error.httpStatus !== 400) throw error
      if (/message to edit not found|message can't be edited/i.test(error.detail)) return this.send(target, reply)
      // An edit response can be lost after Telegram has already applied it.
      if (!/message is not modified/i.test(error.detail)) throw error
    }
    return messageId
  }

  async readAttachment(target: Destination, _messageId: string, reference: AttachmentReference) {
    if (!this.permits(target) || !/^[\w-]{1,512}$/u.test(reference.resource)) {
      throw new Error('Telegram 文件标识无效')
    }
    const file = await this.api<{file_path?: string; file_size?: number}>('getFile', {file_id: reference.resource})
    const path = file.file_path?.split('/') ?? []
    if (!path.length || path.some(part => !/^[\w.-]+$/u.test(part) || part === '.' || part === '..') ||
      (file.file_size !== undefined && file.file_size > maxMediaBytes)) {
      throw new Error('Telegram 文件不可下载')
    }
    const response = await this.request('https://api.telegram.org/file/bot' + this.token + '/' + path.join('/'), {
      redirect: 'error', signal: AbortSignal.any([this.signal, AbortSignal.timeout(15000)]),
    })
    return mediaResponse(response, reference)
  }

  decode(update: Update): Incoming | undefined {
    const callback = update.callback_query
    const chat = callback ? callback.message?.chat : update.message?.chat
    const user = callback ? callback.from : update.message?.from
    if (chat?.type !== 'private' || !user || user.is_bot || !Number.isSafeInteger(user.id) || !Number.isSafeInteger(chat.id)) return
    const target = { user: String(user.id), chat: String(chat.id) }
    if (chat.id !== user.id) return
    const msg = callback ? undefined : update.message
    const text = callback ? (callback.data?.startsWith('t:') ? '/inspect ' + callback.data.slice(2) : undefined) : msg?.text ?? msg?.caption
    if (!this.permits(target) && (callback || (!this.approvals && !/^\/pair [a-f0-9]{20}$/i.test(text?.trim() ?? '')))) {
      return
    }
    const photo = msg?.photo?.at(-1)
    const file = msg?.animation ?? msg?.video ?? msg?.video_note ?? msg?.document
    const resources = mediaFields([
      ...(photo ? [attachment(photo.file_id, {kind: 'image', size: photo.file_size})] : []),
      ...(file ? [attachment(file.file_id, {name: file.file_name, mimeType: file.mime_type, size: file.file_size})] : []),
      ...(msg?.voice || msg?.audio || msg?.sticker ? [undefined] : []),
    ])
    if (text?.trim() || resources.attachments || resources.mediaUnavailable) {
      const username = user.username || [user.first_name, user.last_name].filter(Boolean).join(' ')
      return { ...target, id: String(update.update_id), text: text ?? '', ...resources, ...(username && {username}),
        ...(user.language_code && {locale: user.language_code}) }
    }
  }

  /** Telegram acknowledges updates on the next poll with a higher offset. */
  async poll(gateway: ImGateway, state: GatewayState, onFailure: () => void): Promise<void> {
    while (!this.signal.aborted) {
      try {
        const updates = await this.api<Update[]>('getUpdates', {
          offset: state.offset(this.id), timeout: 20, allowed_updates: ['message', 'callback_query'],
        })
        for (const update of updates) {
          if (!Number.isSafeInteger(update.update_id)) throw new Error('Invalid update ID')
          const input = this.decode(update)
          if (input) {
            if (update.callback_query) {
              // Acknowledgement expires quickly; expiration must not discard an authorized read.
              await this.api('answerCallbackQuery', { callback_query_id: update.callback_query.id }).catch(() => {})
            }
            await gateway.receive(input)
          }
          state.advance(this.id, update.update_id + 1)
        }
      } catch (error) {
        if (this.signal.aborted) return
        onFailure()
        const wait = error instanceof ApiError ? Math.max(2, error.retryAfter) : 2
        await delay(Math.min(wait, 3600) * 1000, undefined, { signal: this.signal }).catch(() => {})
      }
    }
  }
}

export function startTelegram(options: TelegramConfig, runtime: ChannelRuntime): Promise<void> {
  const token = channelSecret(runtime, 'token', options.tokenEnv ?? 'TELEGRAM_BOT_TOKEN', () => runtime.state.get('telegram/token'))
  if (!token) throw new Error('Missing Telegram bot token')
  const channel = 'telegram/' + token.split(':')[0]
  const transport = new TelegramTransport(token, options.allowedUserIds ?? [], runtime.signal, fetch, runtime.access(channel), runtime.approvals)
  return transport.poll(runtime.mount(transport), runtime.state, () => runtime.warn('Telegram polling paused; retrying'))
}
