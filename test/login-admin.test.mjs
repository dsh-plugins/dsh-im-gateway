import assert from 'node:assert/strict'
import { setImmediate as tick } from 'node:timers/promises'
import test from 'node:test'
import { LoginAdmin } from '../dist/login-admin.js'
import { loginWechat } from '../dist/channels/wechat.js'
import { loginFeishu } from '../dist/feishu.js'
import { GatewayState } from '../dist/state.js'

const start = (admin, channel) => admin.execute({ op: 'loginStart', channel })
const action = (admin, session, op, fields = {}) => admin.execute({ op, channel: session.channel, loginId: session.loginId, ...fields })
const qr = 'https://liteapp.weixin.qq.com/q/example'

async function waitStatus(admin, session, expected) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const view = await action(admin, session, 'loginStatus')
    if (view.status === expected) return view
    await tick()
  }
  assert.fail('Login did not reach ' + expected)
}

test('real WeChat/Feishu adapters expose only official QR challenges and commit registrations independently', async t => {
  const store = new GatewayState(':memory:')
  const finishFeishu = Promise.withResolvers()
  const refreshed = []
  const admin = new LoginAdmin(store, channel => { refreshed.push(channel) }, { drivers: {
    wechat: (staging, show, code, signal) => loginWechat(staging, show, code, signal, async raw => {
      const url = new URL(raw)
      if (url.pathname.endsWith('get_bot_qrcode')) {
        return Response.json({ qrcode: 'host-only-nonce', qrcode_img_content: qr })
      }
      assert.ok(url.pathname.endsWith('get_qrcode_status'))
      if (!url.searchParams.get('verify_code')) return Response.json({ status: 'need_verifycode' })
      assert.equal(url.searchParams.get('verify_code'), '0037')
      return Response.json({ status: 'confirmed', ilink_bot_id: 'example-bot', bot_token: 'private-wechat-token' })
    }),
    feishu: (staging, show, _code, signal) => loginFeishu(staging, show, signal, async options => {
      options.onQRCodeReady({ url: 'https://open.feishu.cn/registration?user_code=test', expireIn: 600 })
      await finishFeishu.promise
      return { client_id: 'example-app', client_secret: 'private-feishu-secret' }
    }),
  } })
  t.after(async () => { finishFeishu.resolve(); await admin.close(); store.close() })
  const wechat = await start(admin, 'wechat')
  const feishu = await start(admin, 'feishu')
  const challenge = await waitStatus(admin, wechat, 'code')
  assert.equal(challenge.url, qr)
  assert.equal((await start(admin, 'wechat')).loginId, wechat.loginId)
  assert.equal((await action(admin, feishu, 'loginStatus')).status, 'waiting')
  await assert.rejects(action(admin, wechat, 'loginCode', { code: 'abc' }), { code: 'invalid' })
  await assert.rejects(action(admin, wechat, 'loginCode', { channel: 'feishu', code: '0037' }), { code: 'not_found' })
  await action(admin, wechat, 'loginCode', { code: '0037' })
  const wx = await waitStatus(admin, wechat, 'complete')
  assert.equal(JSON.parse(store.get('wechat/registration')).token, 'private-wechat-token')
  assert.equal(store.get('feishu/registration'), undefined)
  finishFeishu.resolve()
  const fs = await waitStatus(admin, feishu, 'complete')
  assert.equal(JSON.parse(store.get('feishu/registration')).appSecret, 'private-feishu-secret')
  assert.deepEqual(refreshed, ['wechat', 'feishu'])
  for (const finished of [wx, fs]) {
    assert.deepEqual(Object.keys(finished).sort(), ['channel', 'expiresAt', 'loginId', 'status'])
  }
})

test('late replies after cancellation, replacement or shutdown cannot publish credentials', async () => {
  const store = new GatewayState(':memory:')
  store.set('wechat/registration', 'previous')
  const responses = []
  const admin = new LoginAdmin(store, () => assert.fail('cancelled attempt was committed'), { drivers: {
    wechat: async (staging, show) => {
      assert.equal(staging.get('wechat/registration'), 'previous')
      const response = Promise.withResolvers()
      responses.push(response)
      show(qr)
      staging.set('wechat/registration', await response.promise)
    },
  } })
  const first = await start(admin, 'wechat')
  assert.equal((await action(admin, first, 'loginCancel')).status, 'cancelled')
  assert.equal((await action(admin, first, 'loginStatus')).url, undefined)
  const next = await start(admin, 'wechat')
  assert.notEqual(first.loginId, next.loginId)
  await assert.rejects(action(admin, first, 'loginCancel'), { code: 'not_found' })
  let closed = false
  const shutdown = admin.close().then(() => { closed = true })
  responses[1].resolve('second-late-token')
  await tick()
  assert.equal(closed, false)
  responses[0].resolve('first-late-token')
  await shutdown
  assert.equal(store.get('wechat/registration'), 'previous')
  await assert.rejects(start(admin, 'wechat'), { code: 'unavailable' })
  store.close()
})

test('deadline aborts an outstanding verification-code prompt; an expired handle cannot accept a code', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 })
  const store = new GatewayState(':memory:')
  const admin = new LoginAdmin(store, () => assert.fail(), { timeoutMs: 50, drivers: {
    wechat: async (staging, show, askCode) => { show(qr); await askCode(); staging.set('wechat/registration', 'too-late') },
  } })
  t.after(async () => { await admin.close(); store.close() })
  const session = await start(admin, 'wechat')
  assert.equal(session.status, 'code')
  assert.equal(session.expiresAt, 1050)
  t.mock.timers.tick(51)
  const ended = await action(admin, session, 'loginStatus')
  assert.equal(ended.status, 'expired')
  assert.equal(ended.url, undefined)
  await assert.rejects(action(admin, session, 'loginCode', { code: '1111' }), { code: 'not_found' })
  assert.equal(store.get('wechat/registration'), undefined)
})

test('provider expiration, invalid QR hosts, and private provider errors are returned as safe terminal states', async t => {
  const store = new GatewayState(':memory:')
  t.after(() => store.close())
  for (const [url, error, status] of [
    ['https://open.larksuite.com/register', { code: 'expired_token' }, 'expired'],
    ['https://feishu.cn.evil.example/secret', null, 'error'],
    ['http://open.feishu.cn/secret', null, 'error'],
    ['https://user:password@open.feishu.cn/secret', null, 'error'],
    ['https://open.feishu.cn/register', new Error('secret-containing upstream exception'), 'error'],
  ]) {
    const admin = new LoginAdmin(store, () => assert.fail(), { drivers: {
      feishu: async (_staging, show) => { show(url); throw error },
    } })
    const session = await start(admin, 'feishu')
    const result = await waitStatus(admin, session, status)
    assert.deepEqual(Object.keys(result).sort(), ['channel', 'expiresAt', 'loginId', 'status'])
    assert.equal(store.get('feishu/registration'), undefined)
    await admin.close()
  }
})

test('the host uses Feishu’s advertised QR lifetime when shorter than its own deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 })
  const store = new GatewayState(':memory:')
  const admin = new LoginAdmin(store, () => assert.fail(), { drivers: {
    feishu: (staging, show, _code, signal) => loginFeishu(staging, show, signal, async options => {
      options.onQRCodeReady({ url: 'https://open.feishu.cn/registration?user_code=sample', expireIn: 2 })
      await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    }),
  } })
  t.after(async () => { await admin.close(); store.close() })
  const session = await start(admin, 'feishu')
  assert.equal(session.expiresAt, 3000)
  assert.equal(session.status, 'waiting')
  t.mock.timers.tick(1999)
  assert.equal((await action(admin, session, 'loginStatus')).status, 'waiting')
  t.mock.timers.tick(1)
  assert.equal((await action(admin, session, 'loginStatus')).status, 'expired')
  assert.equal(store.get('feishu/registration'), undefined)
})
