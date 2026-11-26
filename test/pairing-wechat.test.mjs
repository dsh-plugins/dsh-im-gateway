import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { GatewayState, ImGateway, principal } from '../dist/index.js'
import { startWechat, loginWechat } from '../dist/channels/wechat.js'
import { locales, messages } from '../dist/i18n.js'
import { splitText } from '../dist/transport.js'

test('channel-bound pairing is single use, preserves authorization after restart, and allows a local language choice', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'prism-im-pair-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'im.sqlite')
  const state = new GatewayState(path)
  const code = state.issuePairingCode('wechat')
  const dest = { user: 'a', chat: 'a' }
  assert.equal(state.claim('qq/1', dest, code), false)
  const sent = []
  const s = { messages: [], tasks: [], models: [{ id: 'flash', description: 'base' }], modelId: 'flash' }
  const core = { async view() { return s }, async message() { throw Error('commands are never L1 prompts') }, subscribe() { return () => {} } }
  const channel = 'wechat/1'
  const gateway = new ImGateway(core, state, { id: channel, permits: target => state.paired(channel, target),
    async send(target, reply) { sent.push(reply); return String(sent.length) } })
  await gateway.receive({ ...dest, text: '/pair ' + code, id: '1', locale: 'en-US' })
  assert.equal(sent[0].text, 'This private chat is paired.')
  assert.equal(state.claim(channel, { user: 'b', chat: 'b' }, code), false)
  await gateway.receive({ ...dest, text: '/language ja', id: '2' })
  await gateway.receive({ ...dest, text: '/models', id: '3', locale: 'en-US' })
  assert.match(sent.at(-1).text, /使用中/)
  await gateway.close()
  state.close()
  const restored = new GatewayState(path)
  assert(restored.paired(channel, dest))
  assert(!restored.paired('wechat/other-bot', dest))
  assert.equal(restored.get('language/' + principal(channel, dest)), 'ja')
  assert.equal((await stat(path)).mode & 0o777, 0o600)
  restored.close()
  for (const locale of locales) assert.deepEqual(Object.keys(messages(locale)).sort(), Object.keys(messages('en')).sort())
  const text = '语🎵'.repeat(2000)
  const chunks = splitText(text, 2000, 3900)
  assert.equal(chunks.join(''), text)
  assert(chunks.every(s => s.length <= 2000 && Buffer.byteLength(s) <= 3900 && s.isWellFormed()))
})

test('iLink QR, regional redirect, phone verification, cursor, private text and uint64 receipts', async () => {
  const state = new GatewayState(':memory:')
  const controller = new AbortController()
  const seen = []
  const account = 'bot@im.bot'
  const user = 'u@im.wechat'
  const loginResults = [
    { status: 'scaned_but_redirect', redirect_host: 'regional.weixin.qq.com' },
    { status: 'need_verifycode' },
    { status: 'confirmed', ilink_bot_id: account, ilink_user_id: user, bot_token: 'test-token', baseurl: 'https://regional.weixin.qq.com' },
  ]
  const qr = []
  const auth = await loginWechat(state, url => qr.push(url), async () => '5732', controller.signal, async (raw, init) => {
    const url = new URL(raw)
    assert.equal(init.redirect, 'error')
    if (url.pathname.endsWith('/get_bot_qrcode')) {
      assert.equal(url.origin, 'https://ilinkai.weixin.qq.com')
      assert.equal(url.searchParams.get('bot_type'), '3')
      return Response.json({ qrcode: 'nonce', qrcode_img_content: 'https://example.invalid/qr' })
    }
    if (loginResults.length < 3) assert.equal(url.origin, 'https://regional.weixin.qq.com')
    if (loginResults.length === 1) assert.equal(url.searchParams.get('verify_code'), '5732')
    return Response.json(loginResults.shift())
  })
  assert.equal(qr.length, 1)
  assert.deepEqual(auth, { botId: account })
  let polls = 0
  let sent = 0
  const request = async (raw, init) => {
    const url = new URL(raw)
    assert.equal(url.origin, 'https://regional.weixin.qq.com')
    assert.equal(init.headers.Authorization, 'Bearer test-token')
    const body = JSON.parse(init.body)
    if (url.pathname.endsWith('/getupdates')) {
      if (++polls === 1) {
        assert.equal(body.get_updates_buf, '')
        const message = { message_id: 'WIDE_ID', message_type: 1, from_user_id: user, to_user_id: account,
          context_token: 'first-context', item_list: [{ type: 1, text_item: { text: 'Hello' } }] }
        const updates = { ret: 0, get_updates_buf: 'next', msgs: [ { ...message, group_id: 'group' }, { ...message, message_type: 2 }, message ] }
        return new Response(JSON.stringify(updates).replaceAll('"WIDE_ID"', '9223372036854775807'))
      }
      assert.equal(body.get_updates_buf, 'next')
      controller.abort()
      return Response.json({ ret: 0, msgs: [] })
    }
    const result = body.msg
    assert.equal(result.context_token, 'first-context')
    assert.equal(result.to_user_id, user)
    assert.equal(result.client_id, 'delivery-2')
    assert.equal(result.item_list[0].text_item.text, 'Job\n/inspect t')
    sent++
    return new Response('{"ret":0,"message_id":9223372036854775806}')
  }
  await startWechat({}, {
    state, signal: controller.signal, warn: msg => assert.fail(msg),
    access(channel, allowed) { assert.equal(channel, 'wechat/' + account); return target => allowed.includes(target.user) },
    mount(transport) {
      return { async receive(msg) {
        seen.push(msg)
        const id = await transport.send(msg, { text: 'Job', inspectTask: 't', deliveryId: 'delivery-2' })
        assert.equal(id, '9223372036854775806')
      } }
    },
  }, request)
  assert.deepEqual(seen, [{ user, chat: user, id: '9223372036854775807', text: 'Hello' }])
  assert.equal(sent, 1)
  state.close()
})

test('CLI setup preserves configuration and issues a pairing code usable by the running host', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'prism-im-cli-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const cfg = join(dir, 'prism.json')
  await writeFile(cfg, JSON.stringify({ orchestrator: { existing: true }, im: { statePath: 'example.sqlite' } }))
  const cli = new URL('../scripts/prism-im.mjs', import.meta.url).pathname
  const { stdout } = await promisify(execFile)(process.execPath, [cli, 'setup', 'telegram', '--config', cfg])
  const code = /\/pair ([0-9A-F]{20})/.exec(stdout)?.[1]
  assert(code)
  const config = JSON.parse(await readFile(cfg, 'utf8'))
  assert.deepEqual(config, { orchestrator: { existing: true }, im: { statePath: 'example.sqlite', telegram: {} } })
  const state = new GatewayState(join(dir, 'example.sqlite'))
  assert(state.claim('telegram/44', { chat: '123', user: '123' }, code))
  state.close()
})

test('a push frame awaiting DSH is replayed in order after a gateway restart', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'prism-im-push-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const db = join(dir, 'gateway.sqlite')
  const input = { user: 'u', chat: 'u', id: 'evt-1', text: 'saved request' }
  const channel = { id: 'push/test', permits: () => true }
  const core = { view: async () => ({ messages: [], tasks: [], models: [] }),
    message: async () => { throw Error('offline') }, subscribe: () => () => {} }
  const state = new GatewayState(db)
  const first = new ImGateway(core, state, channel)
  await assert.rejects(first.receive(input), /offline/)
  await first.close()
  state.close()
  const restarted = new GatewayState(db)
  const received = []
  const second = new ImGateway({ ...core, async message(owner, text, id) { received.push({owner,text,id}) } }, restarted, channel)
  second.start()
  await second.receive(input)
  await second.close()
  assert.deepEqual(received, [{ owner: principal(channel.id, input), text: input.text, id: input.id }])
  assert.equal(restarted.pendingInputs(principal(channel.id, input)).length, 0)
  restarted.close()
})

test('CLI help and pairing instructions follow system language and the configured locale', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'prism-im-cli-locale-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const cfg = join(dir, 'prism.json')
  await writeFile(cfg, JSON.stringify({ im: { statePath: 'im.sqlite', locale: 'ja' } }))
  const cli = new URL('../scripts/prism-im.mjs', import.meta.url).pathname
  const env = { ...process.env, DSH_LOCALE: '', LC_ALL: '', LC_MESSAGES: 'zh_CN.UTF-8', LANG: 'en_US.UTF-8' }
  const { stdout: help } = await promisify(execFile)(process.execPath, [cli, '--help'], { env })
  assert.match(help, /支持的通道/)
  for (const flag of ['--config', '--state']) assert(help.includes(flag))
  const { stdout } = await promisify(execFile)(process.execPath, [cli, 'pair', 'telegram', '--config', cfg], { env })
  assert.match(stdout, /10分以内/)
  assert.match(stdout, /\/pair [0-9A-F]{20}/)
})
