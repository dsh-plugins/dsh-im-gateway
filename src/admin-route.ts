import type { IncomingMessage } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { AdminError, isChannel, object, type Channel, type ChannelView } from './admin-config.js'
import type { LoginAdmin } from './login-admin.js'
import type { ApprovalDecision, ApprovalView } from './state.js'

const statusCodes = {invalid: 400, forbidden: 403, not_found: 404, conflict: 409, unavailable: 503}
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const parts: Buffer[] = []
  let size = 0
  for await (const data of req.iterator({destroyOnReturn: false})) {
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data)
    size += chunk.length
    if (size > 64 * 1024) {
      req.resume()
      throw new AdminError('invalid')
    }
    parts.push(chunk)
  }
  try { return object(JSON.parse(Buffer.concat(parts).toString('utf8'))) }
  catch { throw new AdminError('invalid') }
}

interface Administration {
  list(): Promise<ChannelView[]>
  approvals(): ApprovalView[]
  decideApproval(id: string, decision: ApprovalDecision): boolean | 'conflict'
  save(channel: Channel, request: Record<string, unknown>): Promise<ChannelView>
  pair(channel: Channel): {code: string; expiresAt: number}
  login: Pick<LoginAdmin, 'execute'>
}

export function adminRoute(admin: Administration): WebRoute {
  return {kind: 'exact', path: '/prism/im/admin', auth: 'required', async handler(req, res, peer) {
    res.setHeader('Cache-Control', 'private, no-store')
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    try {
      if (!peer || peer.signal.aborted || peer.principal.kind !== 'owner') throw new AdminError('forbidden')
      if (req.headers['sec-fetch-site'] === 'cross-site') throw new AdminError('forbidden')
      if (req.method === 'GET') {
        const channels = await admin.list()
        if (peer.signal.aborted) {
          throw new AdminError('forbidden')
        }
        res.end(JSON.stringify({channels, approvals: admin.approvals()}))
        return
      }
      if (req.method !== 'POST') { res.writeHead(405, {Allow: 'GET, POST'}); res.end(); return }
      const origin = typeof req.headers.origin === 'string' ? URL.parse(req.headers.origin) : null
      if (!origin || !['http:', 'https:'].includes(origin.protocol) || origin.host !== req.headers.host
          || req.headers['x-prism-request'] !== '1') throw new AdminError('forbidden')
      if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new AdminError('invalid')
      const input = await body(req)
      if (input.op === 'decideApproval') {
        if (peer.signal.aborted || typeof input.id !== 'string' ||
            !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(input.id) ||
            (input.decision !== 'approve' && input.decision !== 'reject')) {
          throw new AdminError('invalid')
        }
        const result = admin.decideApproval(input.id, input.decision)
        if (!result || result === 'conflict') {
          throw new AdminError(result === 'conflict' ? 'conflict' : 'not_found')
        }
        res.end(JSON.stringify({ok: true}))
        return
      }
      if (peer.signal.aborted || !isChannel(input.channel) || typeof input.op !== 'string') throw new AdminError('invalid')
      if (input.op === 'pair') { res.end(JSON.stringify(admin.pair(input.channel))); return }
      if (input.op === 'save') {
        res.end(JSON.stringify(await admin.save(input.channel, input))); return
      }
      if (!['loginStart', 'loginStatus', 'loginCancel', 'loginCode'].includes(input.op)
          || (input.channel !== 'wechat' && input.channel !== 'feishu')) throw new AdminError('invalid')
      if (input.loginId !== undefined && typeof input.loginId !== 'string'
          || input.code !== undefined && typeof input.code !== 'string') throw new AdminError('invalid')
      res.end(JSON.stringify(await admin.login.execute({
        channel: input.channel, op: input.op, loginId: input.loginId, code: input.code,
      })))
    } catch (error) {
      const code = error instanceof AdminError ? error.code : 'unavailable'
      res.statusCode = statusCodes[code]
      res.end(JSON.stringify({error: code}))
    }
  }}
}
