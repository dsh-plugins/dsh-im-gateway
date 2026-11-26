import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { Client, LoggerLevel } from '@larksuiteoapi/node-sdk'
import test from 'node:test'
import { decodeFeishu, FeishuTransport, loginFeishu } from '../dist/feishu.js'
import { GatewayState } from '../dist/state.js'

const textEvent = {
  app_id: 'bot', sender: { sender_type: 'user', sender_id: { open_id: 'person' } },
  message: { message_id: 'm1', chat_type: 'p2p', message_type: 'text', content: '{"text":"hello"}' },
}

test('Feishu accepts only genuine user text delivered to this bot in a direct chat', () => {
  assert.deepEqual(decodeFeishu(textEvent, 'bot'), { user: 'person', chat: 'person', id: 'm1', text: 'hello' })
  for (const event of [
    { ...textEvent, app_id: 'another' },
    { ...textEvent, sender: { ...textEvent.sender, sender_type: 'app' } },
    { ...textEvent, message: { ...textEvent.message, chat_type: 'group' } },
    { ...textEvent, message: { ...textEvent.message, content: 'malformed' } },
  ]) assert.equal(decodeFeishu(event, 'bot'), undefined)
})

test('Feishu sends text privately and updates the same folded interactive task card', async () => {
  const calls = []
  const action = name => async request => {
    calls.push([name, request])
    return { code: 0, data: { message_id: 'remote' } }
  }
  const transport = new FeishuTransport('feishu/feishu/bot', { im: { message: {
    create: action('create'), update: action('update'), patch: action('patch'),
  } } }, target => target.user === 'person')
  const target = { chat: 'person', user: 'person' }
  assert.equal(transport.permits(target), true)
  assert.equal(transport.permits({ ...target, chat: 'room' }), false)
  await transport.send(target, { text: 'hello' })
  assert.deepEqual(calls[0][1], { params: { receive_id_type: 'open_id' },
    data: { receive_id: 'person', msg_type: 'text', content: '{"text":"hello"}' } })
  const task = { text: 'Planning', inspectTask: '123' }
  const id = await transport.send(target, task)
  const card = JSON.parse(calls[1][1].data.content)
  assert.equal(card.body.elements[0].tag, 'collapsible_panel')
  assert.equal(card.body.elements[0].expanded, false)
  assert.match(card.body.elements[0].elements[0].content, /\/inspect 123/u)
  await transport.edit(target, id, { ...task, text: 'Done' })
  assert.equal(calls[2][0], 'patch')
  assert.deepEqual(calls[2][1].path, { message_id: id })
  await transport.send(target, { text: 'Retryable', deliveryId: 'a'.repeat(64) })
  assert.equal(calls[3][1].data.uuid, 'a'.repeat(40))
  await assert.rejects(transport.edit({ ...target, chat: 'room' }, id, task), /Unauthorized/)
  await assert.rejects(transport.send({ user: 'other', chat: 'other' }, task), /Unauthorized/)
})

test('registerApp uses a minimal bot template, returns QR and persists credentials after approval', async () => {
  const state = new GatewayState(':memory:')
  try {
    let shown
    const register = async options => {
      assert.equal(options.createOnly, true)
      assert.equal(options.addons.preset, false)
      assert.deepEqual(options.addons.events.items.tenant, ['im.message.receive_v1'])
      assert.deepEqual(options.addons.scopes.tenant.sort(), ['im:message.p2p_msg:readonly', 'im:message:send_as_bot', 'im:message:update'])
      options.onQRCodeReady({ url: 'https://open.feishu.cn/example' })
      options.onStatusChange({ status: 'domain_switched' })
      return { client_id: 'bot', client_secret: 'secret', user_info: { open_id: 'person' } }
    }
    const info = await loginFeishu(state, url => { shown = url }, undefined, register)
    assert.equal(shown, 'https://open.feishu.cn/example')
    assert.deepEqual(info, { appId: 'bot', domain: 'lark', openId: 'person' })
    const saved = state.get('feishu/registration')
    assert.equal(JSON.parse(saved).appSecret, 'secret')
    await assert.rejects(loginFeishu(state, () => {}, undefined, async () => { throw new Error('access_denied') }))
    assert.equal(state.get('feishu/registration'), saved)
  } finally { state.close() }
})

test('Feishu official SDK authenticates and sends/edits the bot card via the IM REST routes', async () => {
  const calls = []
  const server = createServer(async (req, res) => {
    const body = []
    for await (const chunk of req) body.push(chunk)
    const payload = JSON.parse(Buffer.concat(body).toString() || '{}')
    calls.push({ method: req.method, url: req.url, authorization: req.headers.authorization, payload })
    const value = req.url.includes('/auth/')
      ? { code: 0, tenant_access_token: 'local-tenant-token', expire: 7200 }
      : { code: 0, data: { message_id: 'om_result' } }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(value))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const client = new Client({ appId: 'cli_test', appSecret: 'test-only',
      domain: 'http://127.0.0.1:' + server.address().port, loggerLevel: LoggerLevel.fatal })
    const transport = new FeishuTransport('feishu/feishu/cli_test', client, () => true)
    const target = { chat: 'ou_user', user: 'ou_user' }
    const id = await transport.send(target, { text: 'Waiting', inspectTask: 'a' })
    await transport.edit(target, id, { text: 'Completed', inspectTask: 'a' })
    assert.ok(calls.some(c => c.url.startsWith('/open-apis/auth/v3/tenant_access_token/internal')))
    const create = calls.find(c => c.url.startsWith('/open-apis/im/v1/messages?'))
    assert.equal(create.method, 'POST')
    assert.equal(create.authorization, 'Bearer local-tenant-token')
    assert.match(create.url, /receive_id_type=open_id/u)
    assert.equal(create.payload.receive_id, target.user)
    assert.ok(calls.some(c => c.method === 'PATCH' && c.url === '/open-apis/im/v1/messages/om_result'))
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})
