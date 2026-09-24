import type { Player, Tournament } from "../domain";

export interface TournamentRepository {
  save(tournament: Tournament): Promise<void>;
  findById(id: string): Promise<Tournament | undefined>;
  findAll(): Promise<Tournament[]>;
  savePlayer(player: Player): Promise<void>;
  findPlayerById(id: string): Promise<Player | undefined>;
  findPlayerByTelegram(telegramUserId: number, username?: string): Promise<Player | undefined>;
  listPlayers(): Promise<Player[]>;
  getCounter(key: string): Promise<number>;
  incrementCounter(key: string, amount: number): Promise<number>;
}

export class InMemoryTournamentRepository implements TournamentRepository {
  private readonly tournaments = new Map<string, Tournament>();
  private readonly players = new Map<string, Player>();
  private readonly counters = new Map<string, number>();

  async save(tournament: Tournament): Promise<void> {
    this.tournaments.set(tournament.id, tournament);
  }

  async findById(id: string): Promise<Tournament | undefined> {
    return this.tournaments.get(id);
  }

  async findAll(): Promise<Tournament[]> {
    return [...this.tournaments.values()];
  }

  async savePlayer(player: Player): Promise<void> {
    this.players.set(player.id, player);
  }

  async findPlayerById(id: string): Promise<Player | undefined> {
    return this.players.get(id);
  }

  async findPlayerByTelegram(telegramUserId: number, username?: string): Promise<Player | undefined> {
    const normalizedUsername = username?.toLowerCase();
    return [...this.players.values()].find((player) =>
      player.telegramUserId === telegramUserId ||
      (normalizedUsername !== undefined && player.telegramUsername?.toLowerCase() === normalizedUsername),
    );
  }

  async listPlayers(): Promise<Player[]> {
    return [...this.players.values()].sort((a, b) => a.name.localeCompare(b.name, "ru"));
  }

  async getCounter(key: string): Promise<number> {
    return this.counters.get(key) ?? 0;
  }

  async incrementCounter(key: string, amount: number): Promise<number> {
    const value = (this.counters.get(key) ?? 0) + amount;
    this.counters.set(key, value);
    return value;
  }
}
