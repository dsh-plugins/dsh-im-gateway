import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ImGateway } from './gateway.js'
import type { GatewayState } from './state.js'
import type { Destination, ImTransport } from './transport.js'

export interface ChannelRuntime {
  readonly signal: AbortSignal
  readonly state: GatewayState
  readonly directory: string
  readonly approvals?: boolean
  readSecret?(field: string): string | undefined
  mount(transport: ImTransport): ImGateway
  access(channel: string, allowedUsers?: readonly string[]): (target: Destination) => boolean
  warn(message: string): void
  webhook(path: string, handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>): void
}

export function channelSecret(runtime: ChannelRuntime, field: string, env: string, fallback?: () => string | undefined) {
  return runtime.readSecret ? runtime.readSecret(field) : process.env[env] ?? fallback?.()
}

export function requiredSecret(runtime: ChannelRuntime, field: string, env: string): string {
  const value = channelSecret(runtime, field, env)
  if (!value?.trim()) throw new Error('Channel credential missing')
  return value
}
