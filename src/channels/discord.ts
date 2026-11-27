import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, Client, DefaultRestOptions, DiscordAPIError, Events,
  GatewayIntentBits, Partials, RESTJSONErrorCodes, type MessageCreateOptions,
} from 'discord.js'
import { attachment, mediaFields, mediaResponse, platformMediaUrl } from '../media.js'
import { channelSecret, type ChannelRuntime } from '../runtime.js'
import type { Destination, Incoming, Reply } from '../transport.js'

export interface DiscordConfig {
  tokenEnv?: string
  allowedUserIds?: string[]
}

const inspectPrefix = 'prism:inspect:'
const attachmentHosts = new Set(['cdn.discordapp.com', 'media.discordapp.net'])

export function discordMessage(message: {
  channel: { type: ChannelType; recipientId?: string | null }
  channelId: string; author: { id: string; bot: boolean; username?: string; globalName?: string | null }
  id: string; content: string; webhookId: string | null
  attachments?: {values(): Iterable<{id: string; name: string; size: number; contentType?: string | null}>}
}): Incoming | undefined {
  if (message.channel.type !== ChannelType.DM || message.author.bot || message.webhookId ||
      message.channel.recipientId !== message.author.id) { return }
  const resources = mediaFields(Array.from(message.attachments?.values() ?? [], item =>
    attachment(item.id, {name: item.name, size: item.size, mimeType: item.contentType})))
  if (!message.content.trim() && !resources.attachments && !resources.mediaUnavailable) { return }
  const username = message.author.globalName || message.author.username
  return { chat: message.channelId, user: message.author.id, text: message.content, id: message.id,
    ...resources, ...(username && {username}) }
}

export function discordPayload(reply: Reply) {
  const button = reply.inspectTask && new ButtonBuilder().setStyle(ButtonStyle.Secondary)
    .setCustomId(inspectPrefix + reply.inspectTask).setLabel(reply.inspectLabel || '/inspect')
  return {
    content: reply.text,
    allowedMentions: { parse: [] },
    components: button ? [new ActionRowBuilder<ButtonBuilder>().addComponents(button)] : [],
  } satisfies MessageCreateOptions
}

export async function startDiscord(config: DiscordConfig, runtime: ChannelRuntime) {
  if (runtime.signal.aborted) return
  const token = channelSecret(runtime, 'token', config.tokenEnv ?? 'DISCORD_BOT_TOKEN')
  if (!token) throw new Error('Discord bot token environment variable is empty')
  // Discord delivers DM contents without the privileged guild message-content intent.
  const client = new Client({
    intents: [GatewayIntentBits.DirectMessages], partials: [Partials.Channel],
    rest: { makeRequest(url, init) {
      runtime.signal.throwIfAborted()
      const signal = init.signal ? AbortSignal.any([runtime.signal, init.signal]) : runtime.signal
      return DefaultRestOptions.makeRequest(url, { ...init, signal })
    } },
  })
  const stopped = Promise.withResolvers<void>()
  const stop = () => stopped.resolve()
  runtime.signal.addEventListener('abort', stop, { once: true })
  const privateChannel = async (target: Destination) => {
    const channel = await client.channels.fetch(target.chat)
    if (channel?.type !== ChannelType.DM || channel.recipientId !== target.user)
      throw new Error('Discord direct message recipient does not match')
    return channel
  }
  const send = async (target: Destination, reply: Reply) => {
    const channel = await privateChannel(target)
    const nonce = reply.deliveryId?.slice(0, 24)
    const message = await channel.send({ ...discordPayload(reply), ...(nonce ? { nonce, enforceNonce: true } : {}) })
    return message.id
  }
  client.once(Events.ClientReady, ready => {
    if (runtime.signal.aborted) return
    const id = 'discord/' + ready.user.id
    const permits = runtime.access(id, config.allowedUserIds)
    const gateway = runtime.mount({
      id, maxTextLength: 2000, permits,
      send,
      async readAttachment(target, messageId, reference) {
        if (!permits(target) || !/^\d{1,24}$/u.test(messageId) || !/^\d{1,24}$/u.test(reference.resource)) {
          throw new Error('Discord 附件标识无效')
        }
        const channel = await privateChannel(target)
        const message = await channel.messages.fetch({message: messageId, cache: false, force: true})
        const file = message.attachments.get(reference.resource)
        const url = platformMediaUrl(file?.url, attachmentHosts)
        const trusted = file && attachment(file.id, {name: file.name, size: file.size, mimeType: file.contentType})
        if (message.author.id !== target.user || message.author.bot || message.webhookId || !trusted ||
          !url?.pathname.startsWith('/attachments/' + target.chat + '/' + reference.resource + '/')) {
          throw new Error('Discord 附件不属于当前私聊消息')
        }
        const response = await fetch(url, {
          redirect: 'error', signal: AbortSignal.any([runtime.signal, AbortSignal.timeout(15000)]),
        })
        return mediaResponse(response, trusted)
      },
      async edit(target, messageId, reply) {
        const channel = await privateChannel(target)
        try {
          return (await channel.messages.edit(messageId, discordPayload(reply))).id
        } catch (error) {
          if (error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.UnknownMessage) return send(target, reply)
          throw error
        }
      },
    })
    client.on(Events.MessageCreate, message => {
      const input = discordMessage(message)
      if (input) void gateway.receive(input).catch(() => runtime.warn('Discord message processing failed'))
    })
    client.on(Events.InteractionCreate, async interaction => {
      if (!interaction.isButton() || !interaction.customId.startsWith(inspectPrefix) ||
          interaction.channel?.type !== ChannelType.DM || interaction.channel.recipientId !== interaction.user.id ||
          interaction.message.author.id !== ready.user.id) return
      const target = {chat: interaction.channelId, user: interaction.user.id}
      if (!permits(target)) {
        return
      }
      try {
        await interaction.deferUpdate()
        await gateway.receive({ ...target, id: interaction.id,
          locale: interaction.locale, text: '/inspect ' + interaction.customId.slice(inspectPrefix.length) })
      } catch { runtime.warn('Discord task inspection failed') }
    })
  })
  client.on(Events.Error, () => runtime.warn('Discord connection error'))
  try {
    // Login can wait indefinitely for a shard's first ready event, even after destroy().
    await Promise.race([client.login(token).then(() => stopped.promise), stopped.promise])
  } catch (error) {
    if (!runtime.signal.aborted) throw error
  } finally {
    runtime.signal.removeEventListener('abort', stop)
    await client.destroy()
  }
}
