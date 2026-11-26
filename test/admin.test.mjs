import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { apply, GatewayState } from '../dist/index.js'
import { channels, ChannelConfiguration } from '../dist/admin-config.js'
import { ChannelSupervisor } from '../dist/supervisor.js'

function makeState(t) {
  const state = new GatewayState(':memory:')
  t.after(() => state.close())
  return state
}

test('all seven channel profiles persist write-only values, permit explicit removal and detect stale edits', t => {
  const state = makeState(t)
  const config = new ChannelConfiguration(state, {})
  const samples = {
    telegram: [{}, {token: '123456:unit-test'}],
    wechat: [{}, {}],
    feishu: [{appId: 'cli_test', domain: 'lark'}, {appSecret: 'test-feishu-secret'}],
    wecom: [{botId: 'test-bot'}, {secret: 'test-wecom-secret'}],
    qq: [{appId: '123456'}, {appSecret: 'test-qq-secret'}],
    onebot: [{selfId: '23456', apiBase: 'http://127.0.0.1:8080'}, {accessToken: 'test-outbound', eventSecret: 'test-inbound'}],
    discord: [{}, {token: 'test-discord-secret'}],
  }
  assert.deepEqual(Object.keys(samples), channels)
  for (const channel of channels) {
    const [publicFields, secrets] = samples[channel]
    const fields = {...publicFields, allowedUserIds: ['123', '123']}
    const initial = config.view(channel, 'disabled')
    assert.equal(initial.enabled, false)
    config.save(channel, {fields, secrets, enabled: false, revision: initial.revision})
    const reloaded = new ChannelConfiguration(state, {})
    const view = reloaded.view(channel, 'disabled')
    assert.equal(view.revision, 1)
    assert.deepEqual(view.fields, {...publicFields, allowedUserIds: ['123']})
    for (const [key, value] of Object.entries(secrets)) {
      assert.equal(view.secrets[key], true)
      assert.equal(reloaded.secret(channel, key), value)
      assert.equal(JSON.stringify(view).includes(value), false)
    }
    assert.throws(() => config.save(channel, {fields: {}, enabled: false, revision: 0}), {message: 'conflict'})
    reloaded.save(channel, {fields: {}, enabled: false, revision: 1})
    assert.deepEqual(reloaded.view(channel, 'disabled').secrets, view.secrets)
    for (const key of Object.keys(secrets)) assert.equal(reloaded.secret(channel, key), secrets[key])
    const cleared = Object.fromEntries(Object.keys(secrets).map(key => [key, null]))
    reloaded.save(channel, {fields: {}, secrets: cleared, enabled: false, revision: 2})
    assert.ok(Object.values(reloaded.view(channel, 'disabled').secrets).every(has => !has))
  }
})

test('validates per-channel options, preserves legacy permission lists and uses the registered Feishu region', t => {
  const state = makeState(t)
  const config = new ChannelConfiguration(state, {wecom: {botId: 'legacy-bot', allowedUsers: ['legacy-user']}})
  assert.deepEqual(config.view('wecom', 'disabled').fields, {allowedUserIds: ['legacy-user'], botId: 'legacy-bot'})
  assert.deepEqual(config.options('wecom'), {botId: 'legacy-bot', allowedUsers: ['legacy-user']})
  const edit = (channel, fields = {}, secrets = {}, enabled = true) => config.save(channel, {
    fields, secrets, enabled, revision: config.view(channel, 'disabled').revision,
  })
  for (const channel of channels.filter(ch => ch !== 'wecom')) {
    assert.throws(() => edit(channel), {message: 'invalid'})
    assert.equal(config.view(channel, 'disabled').revision, 0)
  }
  assert.throws(() => edit('telegram', {tokenEnv: 'UNRELATED_ENV'}, {}, false), {message: 'invalid'})
  assert.throws(() => edit('onebot', {apiBase: 'https://demo.invalid/?token=x'}, {}, false), {message: 'invalid'})
  assert.throws(() => edit('qq', {appId: 'x'}, {}, false), {message: 'invalid'})
  edit('onebot', {selfId: '42', apiBase: 'http://localhost:4100'}, {eventSecret: 'test-one', accessToken: 'test-two'})
  assert.throws(() => edit('onebot', {apiBase: 'http://localhost:4101'}), {message: 'invalid'})
  edit('onebot', {apiBase: 'http://localhost:4101'}, {accessToken: 'new-test-two'})

  edit('feishu', {appId: 'manual', domain: 'feishu'}, {appSecret: 'manual-test-only'})
  state.set('feishu/registration', JSON.stringify({appId: 'registered', appSecret: 'registration-test-only', domain: 'lark'}))
  config.registered('feishu')
  const visible = config.view('feishu', 'running')
  assert.equal(visible.registered, true)
  assert.deepEqual(visible.fields, {allowedUserIds: [], domain: '', appId: ''})
  assert.deepEqual(visible.secrets, {appSecret: false})
  assert.deepEqual(config.options('feishu'), {allowedUserIds: []})
  assert.throws(() => edit('feishu', {domain: 'feishu'}), {message: 'invalid'})
  edit('feishu', {domain: 'lark'})
  edit('feishu', {domain: ''})
  assert.deepEqual(config.options('feishu'), {allowedUserIds: []})
})

test('the native owner route saves, starts and stops a real webhook transport and recovers after restart', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'prism-im-admin-'))
  const statePath = join(directory, 'im.sqlite')
  const routes = new Map()
  const serverApi = {register(route) {
    assert.ok(!routes.has(route.path))
    routes.set(route.path, route)
    return () => routes.delete(route.path)
  }}
  const ctx = {get: key => key === 'webServer' ? serverApi : {}, logger: () => ({warn() {}, error() {}})}
  let dispose = apply(ctx, {managed: true, statePath})
  let role = 'owner'
  const server = createServer((req, res) => {
    const route = routes.get(req.url)
    if (!route) { res.writeHead(404).end(); return }
    void route.handler(req, res, {principal: {kind: role}, signal: new AbortController().signal})
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = 'http://127.0.0.1:' + server.address().port
  const url = origin + '/prism/im/admin'
  t.after(async () => {
    await dispose()
    await new Promise(resolve => server.close(resolve))
    rmSync(directory, {recursive: true, force: true})
  })
  function post(input, headers = {}) {
    return fetch(url, {method: 'POST', headers: {
      'Content-Type': 'application/json', Origin: origin, 'X-Prism-Request': '1', ...headers,
    }, body: JSON.stringify(input)})
  }
  async function getQQ() { return (await (await fetch(url)).json()).channels.find(c => c.channel === 'qq') }
  async function waitForQQ() {
    for (let i = 0; i < 100 && !routes.has('/prism/im/qq'); i++) await delay(10)
    assert.equal(routes.get('/prism/im/qq')?.auth, 'anonymous')
    assert.equal((await getQQ()).status, 'running')
  }
  assert.equal(routes.get('/prism/im/admin').auth, 'required')
  const response = await fetch(url)
  assert.match(response.headers.get('cache-control'), /no-store/)
  assert.deepEqual((await response.json()).channels.map(c => c.channel), channels)
  const edit = {op: 'save', channel: 'qq', revision: 0, fields: {appId: '123456'}, enabled: true, secrets: {appSecret: 'fixture-qq-secret'}}
  role = 'member'
  assert.equal((await fetch(url)).status, 403)
  assert.equal((await post(edit)).status, 403)
  role = 'owner'
  assert.equal((await post(edit, {Origin: 'https://example.invalid'})).status, 403)
  assert.equal((await post(edit, {'X-Prism-Request': ''})).status, 403)
  assert.equal((await post(edit, {'Content-Type': 'text/plain'})).status, 400)
  assert.equal((await getQQ()).revision, 0)
  const saved = await post(edit)
  assert.equal(saved.status, 200)
  assert.equal((await saved.text()).includes(edit.secrets.appSecret), false)
  await waitForQQ()
  assert.equal((await post(edit)).status, 409)
  await dispose()
  assert.equal(routes.size, 0)
  dispose = apply(ctx, {managed: true, statePath})
  await waitForQQ()
  const pair = {op: 'pair', channel: 'qq'}
  role = 'member'
  assert.equal((await post(pair)).status, 403)
  role = 'owner'
  const pairing = await (await post(pair)).json()
  assert.match(pairing.code, /^[A-F\d]{20}$/)
  assert.ok(pairing.expiresAt >= Date.now() + 590_000)
  const state = new GatewayState(statePath)
  try {
    const target = {chat: 'direct-chat', user: 'direct-user'}
    assert.equal(state.claim('telegram/123', target, pairing.code), false)
    assert.equal(state.claim('qq/123456', target, pairing.code), true)
    assert.equal(state.claim('qq/123456', target, pairing.code), false)
  } finally { state.close() }
  const stopped = await (await post({...edit, enabled: false, revision: 1, secrets: {}})).json()
  assert.equal(stopped.status, 'disabled')
  assert.equal(stopped.secrets.appSecret, true)
  assert.equal(routes.has('/prism/im/qq'), false)
})

test('a stopped WeChat poll is visible and a standalone plugin keeps its own configuration', async t => {
  const state = makeState(t)
  const ctx = {logger: () => ({warn() {}, error() {}})}
  let startedWith
  const runner = new ChannelSupervisor(ctx, {wechat: {allowedUserIds: ['legacy']}}, state, ':memory:', {
    wechat: async options => { startedWith = options },
  })
  runner.configuration.save('wechat', {fields: {allowedUserIds: ['browser']}, secrets: {}, enabled: false, revision: 0})
  runner.start('wechat')
  await delay(0)
  assert.deepEqual(startedWith, {allowedUserIds: ['legacy']})
  assert.equal(runner.view('wechat').status, 'error')
  await runner.close()
})
