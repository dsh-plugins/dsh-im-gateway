import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ChannelType, Client, DefaultRestOptions } from 'discord.js'
import { discordMessage, discordPayload, startDiscord } from '../dist/channels/discord.js'

test('Discord routes a direct message only for the channel recipient', () => {
  const message = { channel: { type: ChannelType.DM, recipientId: '21' }, author: { id: '21', bot: false },
    channelId: '44', id: '87', content: '/pair ABC', webhookId: null }
  assert.deepEqual(discordMessage(message), { chat: '44', user: '21', id: '87', text: '/pair ABC' })
  for (const change of [{ channel: { type: ChannelType.GuildText } }, { author: { id: '21', bot: true } },
    { channel: { ...message.channel, recipientId: '42' } }, { webhookId: '24' }, { content: '  ' }]) {
    assert.equal(discordMessage({ ...message, ...change }), undefined)
  }
})

test('Discord disables mentions and adds a localized inspection button only for tasks', () => {
  assert.deepEqual(discordPayload({ text: '@everyone' }), { content: '@everyone', components: [], allowedMentions: { parse: [] } })
  const task = discordPayload({ text: 'Running', inspectTask: 'task-1', inspectLabel: 'Details' })
  const button = task.components[0].toJSON().components[0]
  assert.equal(button.custom_id, 'prism:inspect:task-1')
  assert.equal(button.label, 'Details')
})

test('Discord shuts down a client waiting for its first shard-ready event', { timeout: 1500 }, async t => {
  const stop = new AbortController()
  t.mock.method(Client.prototype, 'login', () => new Promise(() => {}))
  const destroy = t.mock.method(Client.prototype, 'destroy')
  process.env.PRISM_DISCORD_PROBE = 'test-token'
  try {
    const worker = startDiscord({ tokenEnv: 'PRISM_DISCORD_PROBE' }, { signal: stop.signal })
    stop.abort()
    await worker
    assert.equal(destroy.mock.callCount(), 1)
  } finally { delete process.env.PRISM_DISCORD_PROBE }
})

test('Discord aborts the official SDK gateway discovery request on shutdown', { timeout: 1500 }, async t => {
  const stop = new AbortController()
  const started = Promise.withResolvers()
  t.mock.method(DefaultRestOptions, 'makeRequest', (url, init) => {
    assert.match(url, /\/gateway\/bot$/)
    started.resolve(init.signal)
    return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }))
  })
  process.env.PRISM_DISCORD_PROBE = 'test-token'
  try {
    const worker = startDiscord({ tokenEnv: 'PRISM_DISCORD_PROBE' }, { signal: stop.signal })
    const request = await started.promise
    stop.abort()
    await worker
    assert.equal(request.aborted, true)
  } finally { stop.abort(); delete process.env.PRISM_DISCORD_PROBE }
})
