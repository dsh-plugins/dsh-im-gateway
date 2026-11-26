import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { ImGateway, GatewayState, principal, TelegramTransport } from '../dist/index.js'
import { splitText } from '../dist/transport.js'

function coreFixture() {
  const data = new Map()
  const subscriptions = new Map()
  const calls = []
  const core = {
    async view(owner) {
      if (!data.has(owner)) data.set(owner, {
        modelId: 'flash', models: [{ id: 'flash', description: '快速响应' }, { id: 'deep', description: '细致分析' }],
        messages: [], tasks: [],
      })
      return data.get(owner)
    },
    async selectModel(owner, model) {
      const view = await this.view(owner)
      view.modelId = model
      return view
    },
    async message(owner, text, requestId) {
      calls.push({ owner, requestId })
      const view = await this.view(owner)
      view.messages.push({ id: requestId, role: 'user', text, at: '' })
      return view
    },
    async trace(owner, id) {
      assert((await this.view(owner)).tasks.some(t => t.id === id))
      return [{ role: 'assistant', text: '只读记录' }]
    },
    subscribe(owner, listener) {
      subscriptions.set(owner, listener)
      return () => subscriptions.delete(owner)
    },
  }
  return { core, calls, subscriptions, data }
}

function sink() {
  const sent = []
  const edited = []
  return {
    id: 'telegram/88', sent, edited,
    permits: ({ chat, user }) => chat === user,
    async send(target, reply) {
      const id = String(sent.length + 1)
      sent.push({ id, ...target, ...reply })
      return id
    },
    async edit(target, id, reply) {
      edited.push({ id, ...target, ...reply })
      return id
    },
  }
}

async function until(predicate) {
  for (let i = 0; i < 100 && !predicate(); ++i) await delay(5)
  assert(predicate(), 'timed out waiting for IM delivery')
}

test('inbound retries, unsolicited explicit replies, task card edits and scoped read-only lookup', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'prism-im-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'state.sqlite')
  const { core, calls, subscriptions } = coreFixture()
  const transport = sink()
  const destination = { chat: '3', user: '3' }
  const owner = principal(transport.id, destination)
  const state = new GatewayState(path)
  const gateway = new ImGateway(core, state, transport)
  const first = { ...destination, id: '11', text: '测试消息' }
  await Promise.all([gateway.receive(first), gateway.receive(first)])
  assert.equal(calls.length, 1)
  const view = await core.view(owner)
  view.messages.push({ role: 'assistant', id: 'out1', text: '主动消息' })
  view.tasks.push({ id: 'abc', title: '核对结果', status: 'running' })
  subscriptions.get(owner)(view)
  await until(() => transport.sent.length === 2)
  assert.deepEqual(transport.sent.map(m => m.text), ['主动消息', '任务 · 进行中\n核对结果'])
  view.tasks[0].status = 'completed'
  subscriptions.get(owner)(view)
  await until(() => transport.edited.length === 1)
  assert.equal(transport.edited[0].id, '2')
  assert.equal(transport.edited[0].inspectTask, 'abc')
  await gateway.receive({ ...destination, id: '12', text: '/model 2' })
  assert.equal(view.modelId, 'deep')
  await gateway.receive({ user: '5', chat: '5', id: '13', text: '/inspect abc' })
  assert.equal(transport.sent.at(-1).text, '此对话中没有该任务。')
  await gateway.receive({ ...destination, id: '14', text: '/inspect abc' })
  assert.match(transport.sent.at(-1).text, /只读记录/)
  await gateway.close()
  state.close()

  // Restart with an explicit message generated while the bot was offline.
  view.messages.push({ role: 'assistant', id: 'out2', text: '完成' })
  const afterRestart = new GatewayState(path)
  const resumed = new ImGateway(core, afterRestart, transport)
  resumed.start()
  await until(() => transport.sent.some(m => m.text === '完成'))
  await resumed.receive(first)
  assert.equal(calls.length, 1)
  assert.equal(transport.sent.filter(m => m.text === '主动消息').length, 1)
  assert.equal(transport.edited.length, 1)
  await resumed.close()
  afterRestart.close()
})

test('Telegram authenticates private recipients and commits offsets after successful handling', async () => {
  const controller = new AbortController()
  const offsets = []
  const accepted = []
  const update = (id, type, from, chat) => ({
    update_id: id, message: { text: 'hello', from: { id: from, is_bot: false }, chat: { id: chat, type } },
  })
  const api = async (url, request) => {
    assert(url.endsWith('/getUpdates'))
    offsets.push(JSON.parse(request.body).offset)
    if (offsets.length > 1) {
      controller.abort()
      throw Error('aborted')
    }
    return Response.json({ ok: true, result: [
      update(101, 'group', 7, 77), update(102, 'private', 7, 8), update(103, 'private', 9, 9),
      update(104, 'private', 7, 7),
    ] })
  }
  const transport = new TelegramTransport('25:unit_test', ['7'], controller.signal, api)
  const state = new GatewayState(':memory:')
  await transport.poll({ async receive(input) {
    assert.equal(state.offset(transport.id), 104)
    accepted.push(input)
  } }, state, () => assert.fail('unexpected poll error'))
  assert.deepEqual(accepted, [{ chat: '7', user: '7', id: '104', text: 'hello' }])
  assert.deepEqual(offsets, [undefined, 105])
  state.close()
})

test('long responses split across Telegram limits without corrupting Unicode', () => {
  const original = 'a'.repeat(3999) + '🎵' + '中文'.repeat(3000)
  const chunks = splitText(original)
  assert.equal(chunks.join(''), original)
  assert(chunks.every(text => text.length <= 4000 && text.isWellFormed()))
})

test('Telegram task cards carry a scoped inspect button and can be edited after replay', async () => {
  const calls = []
  const request = async (url, init) => {
    const method = url.split('/').at(-1)
    calls.push({ method, ...JSON.parse(init.body) })
    if (method === 'editMessageText') {
      return Response.json({ ok: false, description: 'Bad Request: message is not modified' }, { status: 400 })
    }
    return Response.json({ ok: true, result: { message_id: 42 } })
  }
  const transport = new TelegramTransport('11:test', ['7'], new AbortController().signal, request)
  const destination = { user: '7', chat: '7' }
  const card = { text: '任务 · 已完成', inspectTask: 'task-123' }
  const remote = await transport.send(destination, card)
  assert.equal(remote, '42')
  assert.deepEqual(calls[0].reply_markup.inline_keyboard, [[{ text: '查看只读会话', callback_data: 't:task-123' }]])
  assert.equal(await transport.edit(destination, remote, card), remote)
  const callback = {
    update_id: 81, callback_query: { id: 'q', message: { chat: { type: 'private', id: 7 } }, from: { id: 7, is_bot: false }, data: 't:task-123' },
  }
  assert.deepEqual(transport.decode(callback), { ...destination, id: '81', text: '/inspect task-123' })
  callback.callback_query.from.id = 8
  assert.equal(transport.decode(callback), undefined)
  await assert.rejects(transport.send({ chat: '8', user: '8' }, { text: 'private' }))
  assert.equal(calls.length, 2)
})
