import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { GatewayState, ImGateway, principal, TelegramTransport } from '../dist/index.js'

test('approval retains the first input, separates bot identities and releases it once after restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'prism-approval-'))
  const file = join(directory, 'im.sqlite')
  const bot = 'onebot/100'
  const target = {chat: '200', user: '200'}
  const owner = principal(bot, target)
  const view = {modelId: 'demo', models: [], messages: [], tasks: []}
  const received = []
  const core = {
    view: async () => view,
    message: async (...message) => { received.push(message); return view },
    subscribe: () => () => {},
  }
  const transport = id => ({id, permits: destination => state.paired(id, destination)})
  let state = new GatewayState(file)
  let gateway = new ImGateway(core, state, transport(bot), undefined, 'zh', {approvals: true})
  try {
    const first = {...target, id: '1', text: 'first', username: ' Example '}
    await gateway.receive(first)
    await gateway.receive({...first, id: '2', text: 'ignored while waiting'})
    await gateway.receive({...first, text: '/pair 1234567890abcdefabcd'})
    assert.deepEqual(received, [])
    assert.deepEqual(state.pendingInputs(owner), [])
    const [request] = state.approvals()
    assert.deepEqual(state.approvals(), [{id: request.id, channel: 'onebot', userId: target.user, username: 'Example'}])
    state.requestApproval('onebot/101', {...first, text: 'other bot'})
    const other = state.approvals()[1]
    assert.notEqual(other.id, request.id)

    await gateway.close()
    state.close()
    state = new GatewayState(file)
    assert.deepEqual(state.decideApproval(other.id, 'reject'), {channel: 'onebot/101', target})
    assert.deepEqual(state.decideApproval(request.id, 'approve'), {channel: bot, target})
    assert.deepEqual(state.decideApproval(request.id, 'approve'), {channel: bot, target})
    assert.equal(state.decideApproval(request.id, 'reject'), 'conflict')
    assert.equal(state.decideApproval(other.id, 'approve'), 'conflict')
    assert.equal(state.requestApproval('onebot/101', {...first, id: '3'}), undefined)
    assert.equal(state.paired('onebot/101', target), false)
    assert.deepEqual(state.pendingInputs(principal('onebot/101', target)), [])
    assert.deepEqual(state.approvals(), [])

    gateway = new ImGateway(core, state, transport(bot), undefined, 'zh', {approvals: true})
    gateway.start()
    await gateway.receive(first)
    assert.deepEqual(received, [[owner, first.text, first.id]])
    assert.deepEqual(state.pendingInputs(owner), [])
  } finally {
    await gateway.close()
    state.close()
    await rm(directory, {recursive: true, force: true})
  }
})

test('Telegram admits verified private text for approval without turning callbacks or group messages into requests', () => {
  const transport = new TelegramTransport('123:token', [], new AbortController().signal, undefined, undefined, true)
  const from = {id: 456, is_bot: false, first_name: 'Example', last_name: 'User'}
  const chat = {type: 'private', id: from.id}
  const input = {update_id: 1, message: {from, chat, text: 'hello'}}
  assert.deepEqual(transport.decode(input), {id: '1', user: '456', chat: '456', username: 'Example User', text: 'hello'})
  assert.equal(transport.decode({...input, message: {...input.message, chat: {...chat, type: 'group'}}}), undefined)
  assert.equal(transport.decode({update_id: 2, callback_query: {id: 'a', from, message: {chat}, data: 't:task'}}), undefined)
})
