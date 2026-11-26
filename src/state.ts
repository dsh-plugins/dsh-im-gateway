import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Destination, Incoming } from './transport.js'

export function principal(channel: string, destination: Destination): string {
  return 'im:' + JSON.stringify([channel, destination.chat, destination.user])
}

/** One long-poll consumer owns a bot token. Rows survive bot and DSH restarts. */
export class GatewayState {
  private readonly db: DatabaseSync

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    if (path !== ':memory:') chmodSync(path, 0o600)
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS destinations (
        channel TEXT NOT NULL, chat TEXT NOT NULL, user TEXT NOT NULL,
        PRIMARY KEY (channel, chat, user)
      );
      CREATE TABLE IF NOT EXISTS inbox (
        seq INTEGER PRIMARY KEY, owner TEXT NOT NULL, event TEXT NOT NULL, payload TEXT NOT NULL,
        UNIQUE(owner, event)
      );
      CREATE TABLE IF NOT EXISTS receipts (
        owner TEXT NOT NULL, item TEXT NOT NULL, remote TEXT NOT NULL, version TEXT NOT NULL,
        PRIMARY KEY (owner, item)
      );
      CREATE TABLE IF NOT EXISTS gateway_values (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS authorized_chats (owner TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS pairing_codes (digest TEXT PRIMARY KEY, channel TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS poll_offsets (
        channel TEXT PRIMARY KEY, next_update INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
    `)
  }

  bind(channel: string, { chat, user }: Destination) {
    this.db.prepare('INSERT OR IGNORE INTO destinations VALUES (?, ?, ?)').run(channel, chat, user)
  }

  list(channel: string): Destination[] {
    return this.db.prepare('SELECT chat, user FROM destinations WHERE channel = ?').all(channel)
      .map(row => ({ chat: String(row.chat), user: String(row.user) }))
  }

  enqueue(channel: string, input: Incoming) {
    const owner = principal(channel, input)
    this.bind(channel, input)
    if (this.receipt(owner, 'in/' + input.id)) return
    this.db.prepare('INSERT OR IGNORE INTO inbox(owner,event,payload) VALUES (?,?,?)')
      .run(owner, input.id, JSON.stringify(input))
  }

  pendingInputs(owner: string): Incoming[] {
    return this.db.prepare('SELECT payload FROM inbox WHERE owner=? ORDER BY seq').all(owner)
      .map(row => JSON.parse(String(row.payload)) as Incoming)
  }

  finishInput(owner: string, event: string) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.delivered(owner, 'in/' + event, 'processed')
      this.db.prepare('DELETE FROM inbox WHERE owner=? AND event=?').run(owner, event)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  receipt(owner: string, item: string) {
    const row = this.db.prepare('SELECT remote, version FROM receipts WHERE owner = ? AND item = ?').get(owner, item)
    return row && { remote: String(row.remote), version: String(row.version) }
  }

  delivered(owner: string, item: string, remote: string, version = '') {
    this.db.prepare('INSERT OR REPLACE INTO receipts VALUES (?, ?, ?, ?)').run(owner, item, remote, version)
  }

  offset(channel: string): number | undefined {
    const row = this.db.prepare('SELECT next_update, updated_at FROM poll_offsets WHERE channel = ?').get(channel)
    // Telegram randomizes the next update_id after a week without updates.
    if (row && Date.now() - Number(row.updated_at) < 7 * 86400_000) return Number(row.next_update)
  }

  advance(channel: string, next: number) {
    this.db.prepare('INSERT OR REPLACE INTO poll_offsets VALUES (?, ?, ?)').run(channel, next, Date.now())
  }

  get(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM gateway_values WHERE key=?').get(key)
    return row && String(row.value)
  }

  set(key: string, value: string): void {
    this.db.prepare('INSERT OR REPLACE INTO gateway_values VALUES (?,?)').run(key, value)
  }

  compareAndSet(key: string, previous: string | undefined, value: string): boolean {
    const result = previous === undefined
      ? this.db.prepare('INSERT OR IGNORE INTO gateway_values VALUES (?, ?)').run(key, value)
      : this.db.prepare('UPDATE gateway_values SET value=? WHERE key=? AND value=?').run(value, key, previous)
    return Number(result.changes) === 1
  }

  paired(channel: string, target: Destination): boolean {
    return !!this.db.prepare('SELECT 1 FROM authorized_chats WHERE owner=?').get(principal(channel, target))
  }

  issuePairingCode(channel: string): string {
    if (!/^[a-z]+(?:\/[^\s]{1,180})?$/.test(channel)) throw new Error('Unknown channel namespace')
    const code = randomBytes(10).toString('hex').toUpperCase()
    this.db.prepare('DELETE FROM pairing_codes WHERE expires <= ?').run(Date.now())
    this.db.prepare('INSERT INTO pairing_codes VALUES (?,?,?)')
      .run(createHash('sha256').update(code).digest('hex'), channel, Date.now() + 600_000)
    return code
  }

  claim(channel: string, target: Destination, code: string): boolean {
    const hash = createHash('sha256').update(code.toUpperCase()).digest('hex')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const row = this.db.prepare('DELETE FROM pairing_codes WHERE digest=? AND channel IN (?,?) AND expires>? RETURNING digest')
        .get(hash, channel, channel.split('/')[0]!, Date.now())
      if (row) this.db.prepare('INSERT OR IGNORE INTO authorized_chats VALUES (?)').run(principal(channel, target))
      this.db.exec('COMMIT')
      return !!row
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  close() { this.db.close() }
}
