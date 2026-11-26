import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import { WSClient } from '@wecom/aibot-node-sdk'
import { WebSocketServer } from 'ws'
import { decodeWecom, WecomTransport } from '../dist/wecom.js'

const direct = { msgid: '1', aibotid: 'bot', chattype: 'single', from: { userid: 'person' }, msgtype: 'text', text: { content: '/models' } }

test('WeCom accepts direct user messages and rejects group conversations and wrong bot identities', () => {
  assert.deepEqual(decodeWecom(direct, 'bot'), { user: 'person', chat: 'person', id: '1', text: '/models' })
  assert.equal(decodeWecom({ ...direct, chattype: 'group', chatid: 'room' }, 'bot'), undefined)
  assert.equal(decodeWecom(direct, 'another'), undefined)
})

test('WeCom official SDK receives a direct callback and sends proactive task updates over WebSocket', { timeout: 6000 }, async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await once(server, 'listening')
  const outgoing = []
  let validAuth = false
  server.on('connection', socket => {
    socket.on('message', bytes => {
      const data = JSON.parse(bytes.toString())
      socket.send(JSON.stringify({ headers: data.headers, errcode: 0, errmsg: 'ok' }))
      if (data.cmd === 'aibot_subscribe') {
        validAuth = data.body.bot_id === 'bot' && data.body.secret === 'test-only'
        socket.send(JSON.stringify({ cmd: 'aibot_msg_callback', headers: { req_id: 'incoming' }, body: direct }))
      } else if (data.cmd === 'aibot_send_msg') outgoing.push(data.body)
    })
  })
  const ws = new WSClient({ botId: 'bot', secret: 'test-only', wsUrl: 'ws://127.0.0.1:' + server.address().port,
    logger: { info() {}, debug() {}, warn() {}, error() {} } })
  const transport = new WecomTransport('wecom/bot', ws, target => target.user === 'person')
  try {
    const incoming = new Promise(resolve => ws.on('message.text', frame => resolve(decodeWecom(frame.body, 'bot'))))
    ws.connect()
    const target = await incoming
    assert.ok(validAuth)
    assert.equal(transport.permits(target), true)
    assert.equal(transport.permits({ ...target, chat: 'room' }), false)
    const receipt = await transport.send(target, { text: 'Queued', inspectTask: 'a' })
    assert.ok(receipt)
    const revision = await transport.edit(target, receipt, { text: 'Done', inspectTask: 'a' })
    assert.notEqual(revision, receipt)
    assert.deepEqual(outgoing.map(message => message.chatid), ['person', 'person'])
    assert.match(outgoing[1].markdown.content, /Done[\s\S]+\/inspect a/u)
  } finally {
    ws.disconnect()
    for (const socket of server.clients) socket.terminate()
    await new Promise(resolve => server.close(resolve))
  }
})
