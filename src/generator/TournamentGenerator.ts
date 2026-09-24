import { randomUUID } from "node:crypto";
import type { Player, Round, Team, Tournament, TournamentInput } from "../domain";
import { BalanceOptimizer } from "./BalanceOptimizer";
import { MatchScheduler } from "./MatchScheduler";
import { PairGenerator } from "./PairGenerator";

const PERFECT_PLAYER_COUNTS = new Set([4, 8, 12, 16]);

export class TournamentGenerator {
  constructor(
    private readonly pairs = new PairGenerator(),
    private readonly scheduler = new MatchScheduler(),
    private readonly optimizer = new BalanceOptimizer(),
  ) {}

  generate(input: TournamentInput): Tournament {
    this.validate(input);
    const players = input.players.map((player) => ({ ...player }));
    const rounds = players.length === 11 && input.courts >= 2
      ? this.generateEqualEleven(players, input.pointsPerMatch)
      : PERFECT_PLAYER_COUNTS.has(players.length)
      ? this.generatePerfect(players, input.courts, input.pointsPerMatch)
      : this.optimizer.generate(players, input.courts, input.pointsPerMatch);

    return {
      id: input.id ?? randomUUID(),
      name: input.name ?? "Americano tournament",
      players,
      courts: input.courts,
      pointsPerMatch: input.pointsPerMatch,
      rounds,
      createdAt: new Date(),
    };
  }

  private generateEqualEleven(players: readonly Player[], pointsToPlay: number): Round[] {
    // Rotate this starter through all 11 players. Distinct cyclic partner
    // distances (1, 3, 5, 2) give everyone eight different partners.
    // Rest positions 0, 4, 8 give everyone three evenly spaced breaks.
    const starter = [[1, 2], [3, 6], [5, 10], [7, 9]] as const;
    const rounds: Round[] = [];
    for (let offset = 0; offset < players.length; offset += 1) {
      const playerAt = (index: number): Player => players[(index + offset) % players.length]!;
      const teams: Team[] = starter.map(([a, b]) => [playerAt(a), playerAt(b)] as const);
      const matches = this.scheduler.pairTeams(teams, rounds, players);
      rounds.push(this.scheduler.toRound(
        matches, offset + 1, [0, 4, 8].map(playerAt), pointsToPlay,
      ));
    }
    return rounds;
  }

  private generatePerfect(
    players: readonly Player[],
    courts: number,
    pointsToPlay: number,
  ): Round[] {
    const partnerRounds = this.pairs.generateCirclePairs(players);
    const rounds: Round[] = [];

    for (const teams of partnerRounds) {
      const pairedTeams = this.scheduler.pairTeams(teams, rounds, players);
      rounds.push(this.scheduler.toRound(pairedTeams, rounds.length + 1, [], pointsToPlay));
    }

    return this.scheduler.packRounds(rounds, players, courts, pointsToPlay);
  }

  private validate(input: TournamentInput): void {
    if (input.players.length < 4) throw new Error("At least 4 players are required");
    if (!Number.isInteger(input.courts) || input.courts < 1) {
      throw new Error("Courts must be a positive integer");
    }
    if (!Number.isInteger(input.pointsPerMatch) || input.pointsPerMatch < 1) {
      throw new Error("Points per match must be a positive integer");
    }
    const ids = new Set(input.players.map((player) => player.id));
    if (ids.size !== input.players.length) throw new Error("Player ids must be unique");
    if (input.players.some((player) => player.name.trim().length === 0)) {
      throw new Error("Player names must not be empty");
    }
  }
}
