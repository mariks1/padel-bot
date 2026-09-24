import type Database from "better-sqlite3";
import type { User } from "grammy/types";
import type { ChatMemberRepository } from "./ChatMemberRepository";

export class SqliteChatMemberRepository implements ChatMemberRepository {
  constructor(private readonly database: Database.Database) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS chat_members (
        chat_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (chat_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS all_cooldowns (
        chat_id INTEGER PRIMARY KEY,
        claimed_at INTEGER NOT NULL
      );
    `);
  }

  save(chatId: number, user: User): void {
    if (user.is_bot) return;
    this.database.prepare(`
      INSERT INTO chat_members (chat_id, user_id, payload) VALUES (?, ?, ?)
      ON CONFLICT(chat_id, user_id) DO UPDATE SET payload = excluded.payload
    `).run(chatId, user.id, JSON.stringify(user));
  }

  remove(chatId: number, userId: number): void {
    this.database.prepare("DELETE FROM chat_members WHERE chat_id = ? AND user_id = ?")
      .run(chatId, userId);
  }

  list(chatId: number): User[] {
    const rows = this.database.prepare("SELECT payload FROM chat_members WHERE chat_id = ? ORDER BY user_id")
      .all(chatId) as { payload: string }[];
    return rows.map((row) => JSON.parse(row.payload) as User);
  }

  acquireAllCooldown(chatId: number, now: number, durationMs: number): number {
    // Reserve atomically before awaiting Telegram, including across processes.
    const result = this.database.prepare(`
      INSERT INTO all_cooldowns (chat_id, claimed_at) VALUES (@chatId, @now)
      ON CONFLICT(chat_id) DO UPDATE SET claimed_at = excluded.claimed_at
      WHERE all_cooldowns.claimed_at <= @now - @durationMs
    `).run({ chatId, now, durationMs });
    if (result.changes > 0) return 0;
    const row = this.database.prepare("SELECT claimed_at FROM all_cooldowns WHERE chat_id = ?")
      .get(chatId) as { claimed_at: number };
    return row.claimed_at + durationMs - now;
  }

  releaseAllCooldown(chatId: number, claimedAt: number): void {
    this.database.prepare("DELETE FROM all_cooldowns WHERE chat_id = ? AND claimed_at = ?")
      .run(chatId, claimedAt);
  }
}
