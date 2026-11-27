import assert from 'node:assert/strict'
import { createCipheriv } from 'node:crypto'
import { Readable } from 'node:stream'
import test from 'node:test'
import { ChannelType, Collection } from 'discord.js'
import { discordMessage } from '../dist/channels/discord.js'
import { startWechat } from '../dist/channels/wechat.js'
import { ExpiringMedia } from '../dist/expiring-media.js'
import { decodeFeishu, FeishuTransport } from '../dist/feishu.js'
import { ImGateway } from '../dist/gateway.js'
import { attachment, binaryMedia, maxMediaBytes, platformMediaUrl } from '../dist/media.js'
import { GatewayState, principal } from '../dist/state.js'
import { TelegramTransport } from '../dist/telegram.js'
import { decodeWecom } from '../dist/wecom.js'

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const target = {user: '3', chat: '3'}
const empty = {messages: [], tasks: [], models: [], modelId: 'fixture'}

test('media is held for approval, stages once before a retried message, and never writes bytes to the inbox', async t => {
  const state = new GatewayState(':memory:')
  const uploads = []
  const delivered = []
  let downloads = 0
  const transport = {
    id: 'telegram/100',
    permits: contact => state.paired('telegram/100', contact),
    async readAttachment(contact, eventId, reference) {
      assert.equal(contact.user, target.user)
      assert.equal(contact.chat, target.chat)
      assert.equal(eventId, 'first-photo')
      assert.equal(reference.resource, 'remote-file')
      downloads++
      return {bytes: png, mimeType: 'image/png'}
    },
    async send() { return '1' },
  }
  const core = {
    async stageMedia(owner, item) {
      uploads.push({owner, item})
      return {assetId: 'fixture-asset', mimeType: item.mimeType}
    },
    async message(owner, text, id, source, ids) {
      delivered.push({owner, text, id, source, ids})
      if (delivered.length === 1) { throw new Error('fixture core rejected the first attempt') }
      return empty
    },
    view: async () => empty,
    subscribe: () => () => {},
  }
  const gateway = new ImGateway(core, state, transport, undefined, 'zh', {approvals: true})
  t.after(async () => { await gateway.close(); state.close() })
  const input = {...target, id: 'first-photo', text: '看这张图', attachments: [attachment('remote-file')]}
  const owner = principal(transport.id, target)
  await gateway.receive(input)
  assert.equal(state.approvals().length, 1)
  assert.equal(downloads, 0)
  state.decideApproval(state.approvals()[0].id, 'approve')
  assert.deepEqual(state.pendingInputs(owner)[0].attachments, input.attachments)
  await assert.rejects(gateway.receive(input), /fixture core/)
  const pending = state.pendingInputs(owner)
  assert.deepEqual(pending[0].preparedMedia, {ids: ['fixture-asset'], unavailable: false})
  assert.equal(pending[0].attachments, undefined)
  assert.equal(downloads, 1)
  await gateway.receive(input)
  assert.equal(downloads, 1)
  assert.equal(uploads.length, 1)
  assert.deepEqual(delivered[0], delivered[1])
  assert.equal(delivered[1].text, input.text)
  assert.deepEqual(delivered[1].ids, ['fixture-asset'])
  assert.deepEqual(state.pendingInputs(owner), [])
})

test('Telegram and Feishu resolve platform file identifiers and preserve captions and DM checks', async () => {
  const requests = []
  const abort = new AbortController()
  const telegram = new TelegramTransport('100:fixture', ['3'], abort.signal, async (raw, options) => {
    const url = new URL(raw)
    assert.equal(url.origin, 'https://api.telegram.org')
    assert.equal(options.redirect, 'error')
    requests.push(url.pathname)
    if (url.pathname.endsWith('/getFile')) {
      assert.deepEqual(JSON.parse(options.body), {file_id: 'image_key'})
      return Response.json({ok: true, result: {file_path: 'photos/p.png'}})
    }
    return new Response(png, {headers: {'Content-Type': 'image/png'}})
  })
  const event = {update_id: 71, message: {from: {id: 3, is_bot: false}, chat: {type: 'private', id: 3},
    caption: '附件说明', photo: [{file_id: 'thumbnail'}, {file_id: 'image_key'}]}}
  const message = telegram.decode(event)
  assert.equal(message.text, '附件说明')
  assert.equal(message.attachments[0].resource, 'image_key')
  assert.deepEqual((await telegram.readAttachment(target, '71', message.attachments[0])).bytes, png)
  await assert.rejects(telegram.readAttachment({...target, chat: 'other'}, '71', message.attachments[0]), /无效/)
  assert.deepEqual(requests, ['/bot100:fixture/getFile', '/file/bot100:fixture/photos/p.png'])

  const image = decodeFeishu({app_id: 'fixture', sender: {sender_type: 'user', sender_id: {open_id: '3'}},
    message: {chat_type: 'p2p', message_type: 'image', message_id: 'msg_abc', content: '{"image_key":"img_abc"}'}}, 'fixture')
  const lark = new FeishuTransport('feishu/fixture', {im: {messageResource: {get: async value => {
    assert.deepEqual(value, {path: {message_id: 'msg_abc', file_key: 'img_abc'}, params: {type: 'image'}})
    return {getReadableStream: () => Readable.from([png]), headers: {}}
  }}}}, user => user.user === target.user)
  assert.equal(image.text, '')
  assert.deepEqual((await lark.readAttachment(target, image.id, image.attachments[0])).bytes, png)
  const post = decodeFeishu({app_id: 'fixture', sender: {sender_type: 'user', sender_id: {open_id: '3'}},
    message: {chat_type: 'p2p', message_type: 'post', message_id: 'msg_post',
      content: JSON.stringify({title: '图文', content: [[{tag: 'text', text: '用户注释'}, {tag: 'img', image_key: 'img_abc'}]]})}}, 'fixture')
  assert.equal(post.text, '图文\n用户注释')
  assert.equal(post.attachments[0].resource, 'img_abc')
})

test('unavailable media returns a Web upload prompt while delivering the caption exactly once', async t => {
  const state = new GatewayState(':memory:')
  const sent = []
  const delivered = []
  const core = {
    view: async () => empty,
    subscribe: () => () => {},
    async message(_owner, text) { delivered.push(text); return empty },
  }
  const gateway = new ImGateway(core, state, {
    id: 'telegram/100', permits: () => true,
    async send(_target, reply) { sent.push(reply.text); return 'ok' },
  })
  t.after(async () => { await gateway.close(); state.close() })
  const input = {...target, id: 'unsupported', text: '继续处理文字', mediaUnavailable: true}
  await gateway.receive(input)
  await gateway.receive(input)
  assert.equal(sent.length, 1)
  assert.match(sent[0], /棱镜网页/)
  assert.deepEqual(delivered, ['继续处理文字'])
})

test('Discord preserves attachment-only private messages and rejects mismatched authors', () => {
  const message = {channel: {type: ChannelType.DM, recipientId: '3'}, id: '11', channelId: '7', content: '',
    author: {id: '3', bot: false}, webhookId: null,
    attachments: new Collection([['9', {id: '9', name: 'a.png', size: png.length, contentType: 'image/png'}]])}
  assert.equal(discordMessage(message).attachments[0].resource, '9')
  assert.equal(discordMessage({...message, channel: {...message.channel, recipientId: '4'}}), undefined)
})

test('temporary encrypted media binds to the originating message and does not preserve CDN keys in a descriptor', async () => {
  const key = Buffer.alloc(32, 7)
  const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16))
  cipher.setAutoPadding(false)
  const encrypted = Buffer.concat([cipher.update(Buffer.concat([png, Buffer.alloc(32 - png.length, 32 - png.length)])), cipher.final()])
  const abort = new AbortController()
  const url = 'https://ww-aibot-img-1258476243.cos.ap-guangzhou.myqcloud.com/a/image?sig=fixture'
  let requests = 0
  const store = new ExpiringMedia(abort.signal, async (raw, init) => {
    requests++
    assert.equal(String(raw), url)
    assert.equal(init.redirect, 'error')
    return new Response(encrypted)
  })
  const input = decodeWecom({aibotid: 'bot', chattype: 'single', from: {userid: '3'}, msgid: 'msg',
    msgtype: 'image', image: {url, aeskey: key.toString('hex')}}, 'bot', store)
  assert.doesNotMatch(JSON.stringify(input), /fixture|aeskey|https:/)
  await assert.rejects(store.read(target, 'different-msg', input.attachments[0]), /过期/)
  assert.equal(requests, 0)
  assert.deepEqual((await store.read(target, input.id, input.attachments[0])).bytes, png)
})

test('iLink decrypts the original image through the verified CDN and forwards a capability reference', async () => {
  const state = new GatewayState(':memory:')
  const abort = new AbortController()
  const key = Buffer.alloc(16, 8)
  const cipher = createCipheriv('aes-128-ecb', key, null)
  const encrypted = Buffer.concat([cipher.update(png), cipher.final()])
  state.set('wechat/registration', JSON.stringify({botId: 'fixture-bot', token: 'fixture', origin: 'https://ilinkai.weixin.qq.com'}))
  let received
  try {
    await startWechat({}, {
      state, signal: abort.signal, access: () => () => true, warn: message => assert.fail(message),
      mount(transport) {
        return {async receive(input) {
          assert.equal(input.text, '')
          assert.doesNotMatch(JSON.stringify(input), /encrypted_query_param|aes_key|https:/)
          received = await transport.readAttachment(target, input.id, input.attachments[0])
          abort.abort()
        }}
      },
    }, async (raw, init) => {
      const url = new URL(raw)
      if (url.hostname === 'novac2c.cdn.weixin.qq.com') {
        assert.equal(init.redirect, 'error')
        assert.equal(url.pathname, '/c2c/download')
        assert.equal(url.searchParams.get('encrypted_query_param'), 'fixture-token')
        return new Response(encrypted)
      }
      assert.equal(url.pathname, '/ilink/bot/getupdates')
      return Response.json({ret: 0, msgs: [{message_type: 1, message_id: '1', from_user_id: target.user,
        to_user_id: 'fixture-bot', context_token: 'fixture-context', item_list: [{type: 2, image_item: {
          aeskey: key.toString('hex'), media: {encrypt_query_param: 'fixture-token'},
        }}]}]})
    })
  } finally { state.close() }
  assert.deepEqual(received.bytes, png)
})

test('CDN hosts, sizes and decoded MIME must pass independent media checks', () => {
  const hosts = new Set(['media.example.invalid'])
  assert.ok(platformMediaUrl('https://media.example.invalid/a', hosts))
  assert.equal(platformMediaUrl('https://media.example.invalid.example/a', hosts), undefined)
  assert.equal(platformMediaUrl('http://media.example.invalid/a', hosts), undefined)
  assert.equal(attachment('asset', {size: maxMediaBytes + 1}), undefined)
  assert.equal(attachment('asset', {mimeType: 'text/html'}), undefined)
  assert.throws(() => binaryMedia(Buffer.from('<svg/>'), attachment('asset')), /文件格式/)
  assert.equal(binaryMedia(png, attachment('asset', {name: 'c:\\folder\\a.png'})).name, 'a.png')
})
