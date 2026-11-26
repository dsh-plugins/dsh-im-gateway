// A loopback substitute for the platform, at the official SDK's HTTP boundary.
import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { defaultHttpInstance } from '@larksuiteoapi/node-sdk'

const record = action => appendFileSync(process.env.PRISM_FEISHU_PROBE_LOG, action + '\n')
const path = '/oauth/v1/app/registration'
const id = 'cli_0123456789abcdef', secret = 'fixture-credential'
defaultHttpInstance.post = async (url, body, config) => {
  assert.equal(config.headers['Content-Type'], 'application/x-www-form-urlencoded')
  const payload = Object.fromEntries(new URLSearchParams(body))
  if (payload.action === 'begin') {
    assert.equal(url, 'https://accounts.feishu.cn' + path)
    assert.deepEqual(payload, { action: 'begin', archetype: 'PersonalAgent', auth_method: 'client_secret', request_user_info: 'open_id' })
    record('begin')
    return { device_code: 'fixture-device', verification_uri_complete: 'https://open.feishu.cn/fixture?user_code=123', expires_in: 8, interval: 1 }
  }
  assert.deepEqual(payload, { action: 'poll', device_code: 'fixture-device' })
  if (url === 'https://accounts.feishu.cn' + path) {
    record('switch')
    return { error: 'authorization_pending', user_info: { tenant_brand: 'lark' } }
  }
  assert.equal(url, 'https://accounts.larksuite.com' + path)
  record('approved')
  return { client_id: id, client_secret: secret, user_info: { open_id: 'ou_scan', tenant_brand: 'lark' } }
}

defaultHttpInstance.request = async options => {
  assert.equal(options.url, 'https://open.larksuite.com/callback/ws/endpoint')
  assert.equal(options.method.toLowerCase(), 'post')
  assert.deepEqual(options.data, { AppID: id, AppSecret: secret })
  record('restore')
  return { code: 0, data: { URL: process.env.PRISM_FEISHU_PROBE_WS, ClientConfig: {
    PingInterval: 60, ReconnectCount: 0, ReconnectInterval: 60, ReconnectNonce: 0,
  } } }
}
