import type Database from "better-sqlite3";
import type { Player, Tournament } from "../domain";
import type { TournamentRepository } from "./TournamentRepository";

interface TournamentRow { payload: string }
interface PlayerRow {
  id: string;
  name: string;
  telegram_user_id: number | null;
  telegram_username: string | null;
}
interface CounterRow { value: number }

export class SqliteTournamentRepository implements TournamentRepository {
  constructor(private readonly database: Database.Database) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS tournaments (
        id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
    database.exec(`
      CREATE TABLE IF NOT EXISTS players (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        telegram_user_id INTEGER UNIQUE,
        telegram_username TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS players_telegram_username_ci
        ON players(lower(telegram_username)) WHERE telegram_username IS NOT NULL;
      CREATE TABLE IF NOT EXISTS bot_counters (
        key TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      );
    `);
  }

  async save(tournament: Tournament): Promise<void> {
    this.database.prepare(`
      INSERT INTO tournaments (id, payload, created_at)
      VALUES (@id, @payload, @createdAt)
      ON CONFLICT(id) DO UPDATE SET payload = excluded.payload
    `).run({
      id: tournament.id,
      payload: JSON.stringify(tournament),
      createdAt: tournament.createdAt.toISOString(),
    });
  }

  async findById(id: string): Promise<Tournament | undefined> {
    const row = this.database.prepare("SELECT payload FROM tournaments WHERE id = ?").get(id) as
      | TournamentRow
      | undefined;
    if (!row) return undefined;
    const parsed = JSON.parse(row.payload) as Omit<Tournament, "createdAt"> & { createdAt: string };
    return { ...parsed, createdAt: new Date(parsed.createdAt) };
  }

  async findAll(): Promise<Tournament[]> {
    const rows = this.database.prepare("SELECT payload FROM tournaments ORDER BY created_at DESC").all() as
      TournamentRow[];
    return rows.map((row) => {
      const parsed = JSON.parse(row.payload) as Omit<Tournament, "createdAt"> & { createdAt: string };
      return { ...parsed, createdAt: new Date(parsed.createdAt) };
    });
  }

  async savePlayer(player: Player): Promise<void> {
    this.database.prepare(`
      INSERT INTO players (id, name, telegram_user_id, telegram_username)
      VALUES (@id, @name, @telegramUserId, @telegramUsername)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        telegram_user_id = excluded.telegram_user_id,
        telegram_username = excluded.telegram_username
    `).run({
      id: player.id,
      name: player.name,
      telegramUserId: player.telegramUserId ?? null,
      telegramUsername: player.telegramUsername ?? null,
    });
  }

  async findPlayerById(id: string): Promise<Player | undefined> {
    const row = this.database.prepare("SELECT * FROM players WHERE id = ?").get(id) as PlayerRow | undefined;
    return row ? this.mapPlayer(row) : undefined;
  }

  async findPlayerByTelegram(telegramUserId: number, username?: string): Promise<Player | undefined> {
    const row = this.database.prepare(`
      SELECT * FROM players
      WHERE telegram_user_id = @telegramUserId
         OR (@username IS NOT NULL AND lower(telegram_username) = lower(@username))
      LIMIT 1
    `).get({ telegramUserId, username: username ?? null }) as PlayerRow | undefined;
    return row ? this.mapPlayer(row) : undefined;
  }

  async listPlayers(): Promise<Player[]> {
    const rows = this.database.prepare("SELECT * FROM players ORDER BY name COLLATE NOCASE").all() as PlayerRow[];
    return rows.map((row) => this.mapPlayer(row));
  }

  async getCounter(key: string): Promise<number> {
    const row = this.database.prepare("SELECT value FROM bot_counters WHERE key = ?")
      .get(key) as CounterRow | undefined;
    return row?.value ?? 0;
  }

  async incrementCounter(key: string, amount: number): Promise<number> {
    this.database.prepare(`
      INSERT INTO bot_counters (key, value) VALUES (@key, @amount)
      ON CONFLICT(key) DO UPDATE SET value = value + excluded.value
    `).run({ key, amount });
    return this.getCounter(key);
  }

  private mapPlayer(row: PlayerRow): Player {
    return {
      id: row.id,
      name: row.name,
      ...(row.telegram_user_id === null ? {} : { telegramUserId: row.telegram_user_id }),
      ...(row.telegram_username === null ? {} : { telegramUsername: row.telegram_username }),
    };
  }
}
