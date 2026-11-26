import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { gunzipSync } from 'node:zlib'
import test from 'node:test'
import { WebSocketServer } from 'ws'
import { GatewayState } from '../dist/state.js'

const run = promisify(execFile)
const fixture = fileURLToPath(new URL('./fixtures/feishu-service.mjs', import.meta.url))
const cli = fileURLToPath(new URL('../scripts/prism-im.mjs', import.meta.url))

test('native CLI registers a Lark app, writes its config and reopens the private channel with the saved credentials', { timeout: 12000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'prism-feishu-qr-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const config = join(dir, 'prism.json'), log = join(dir, 'platform.log')
  await writeFile(config, JSON.stringify({ im: { statePath: './data/im.sqlite', locale: 'en', feishu: {
    appId: 'old', appSecretEnv: 'STALE_TEST_SECRET', domain: 'feishu', allowedUserIds: ['ou_allow'],
  } } }))
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(server, 'listening')
  t.after(() => new Promise(resolve => server.close(resolve)))
  const url = 'ws://127.0.0.1:' + server.address().port + '/fixture?device_id=1&service_id=7'
  const env = { ...process.env, PRISM_FEISHU_PROBE_LOG: log, PRISM_FEISHU_PROBE_WS: url }
  const login = await run(process.execPath, ['--import', fixture, cli, 'login', 'feishu', '--config', config], { cwd: dir, env })
  assert.doesNotMatch(login.stdout + login.stderr, /fixture-credential/)
  const qr = new URL(login.stdout.trim().split('\n').find(line => line.startsWith('https://open.feishu.cn/')))
  assert.equal(qr.searchParams.get('name'), 'DSH Prism')
  assert.equal(qr.searchParams.get('createOnly'), 'true')
  const permissions = JSON.parse(gunzipSync(Buffer.from(qr.searchParams.get('addons'), 'base64url')))
  assert.equal(permissions.preset, false)
  assert.deepEqual(permissions.scopes.tenant, ['im:message.p2p_msg:readonly', 'im:message:send_as_bot', 'im:message:update'])
  assert.deepEqual(permissions.events.items.tenant, ['im.message.receive_v1'])
  const bytes = await readFile(config, 'utf8')
  assert.doesNotMatch(bytes, /fixture-credential/)
  const { im } = JSON.parse(bytes)
  assert.deepEqual(im, { statePath: './data/im.sqlite', locale: 'en', feishu: { allowedUserIds: ['ou_allow'] } })
  const database = join(dir, im.statePath)
  assert.equal((await stat(database)).mode & 0o777, 0o600)
  const state = new GatewayState(database)
  try {
    assert.equal(JSON.parse(state.get('feishu/registration')).openId, 'ou_scan')
  } finally { state.close() }
  let opened = false
  server.on('connection', socket => socket.once('message', () => {
    opened = true
    void writeFile(join(dir, 'ws.ready'), 'connected')
  }))
  const adapter = new URL('../dist/feishu.js', import.meta.url).href
  const gatewayState = new URL('../dist/state.js', import.meta.url).href
  // A fresh process ensures a restart cannot reuse any credentials from CLI memory.
  const restored = await run(process.execPath, ['--import', fixture, '--input-type=module', '-e', `
    import assert from 'node:assert/strict'
    import { existsSync, readFileSync } from 'node:fs'
    import { setTimeout } from 'node:timers/promises'
    import { startFeishu } from ${JSON.stringify(adapter)}
    import { GatewayState } from ${JSON.stringify(gatewayState)}
    const { im } = JSON.parse(readFileSync('prism.json'))
    const state = new GatewayState(im.statePath)
    const stop = new AbortController()
    try {
      await startFeishu(im.feishu, { signal: stop.signal, state, warn: message => { throw new Error(message) },
        access: (id, users) => destination => users.includes(destination.user),
        mount(transport) {
          assert.equal(transport.id, 'feishu/lark/cli_0123456789abcdef')
          for (const user of ['ou_scan','ou_allow']) assert.ok(transport.permits({ chat: user, user }))
          assert.equal(transport.permits({ chat: 'ou_other', user: 'ou_other' }), false)
          return { receive() {} }
        },
      })
      const timeout = Date.now() + 5000
      while (!existsSync('ws.ready')) {
        assert.ok(Date.now() < timeout, 'expected a WebSocket handshake and ping')
        await setTimeout(25)
      }
    } finally { stop.abort(); state.close() }
  `], { cwd: dir, env })
  assert.doesNotMatch(restored.stdout + restored.stderr, /fixture-credential/)
  assert.equal(opened, true)
  assert.deepEqual((await readFile(log, 'utf8')).trim().split('\n'), ['begin', 'switch', 'approved', 'restore'])
})
