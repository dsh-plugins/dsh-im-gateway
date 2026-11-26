import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ImGateway } from './gateway.js'
import type { GatewayState } from './state.js'
import type { Destination, ImTransport } from './transport.js'

export interface ChannelRuntime {
  readonly signal: AbortSignal
  readonly state: GatewayState
  readonly directory: string
  mount(transport: ImTransport): ImGateway
  access(channel: string, allowedUsers?: readonly string[]): (target: Destination) => boolean
  warn(message: string): void
  webhook(path: string, handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>): void
}
