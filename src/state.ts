import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Destination } from './transport.js'

export function principal(channel: string, destination: Destination): string {
  return 'im:' + JSON.stringify([channel, destination.chat, destination.user])
}

/** One long-poll consumer owns a bot token. Rows survive bot and DSH restarts. */
export class GatewayState {
  private readonly db: DatabaseSync

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS destinations (
        channel TEXT NOT NULL, chat TEXT NOT NULL, user TEXT NOT NULL,
        PRIMARY KEY (channel, chat, user)
      );
      CREATE TABLE IF NOT EXISTS receipts (
        owner TEXT NOT NULL, item TEXT NOT NULL, remote TEXT NOT NULL, version TEXT NOT NULL,
        PRIMARY KEY (owner, item)
      );
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

  close() { this.db.close() }
}
