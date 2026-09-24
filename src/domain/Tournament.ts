import type { Player } from "./Player";
import type { Round } from "./Round";

export interface Tournament {
  readonly id: string;
  readonly name: string;
  readonly players: readonly Player[];
  readonly courts: number;
  readonly pointsPerMatch: number;
  readonly rounds: readonly Round[];
  readonly createdAt: Date;
  readonly cancelled?: boolean;
}

export interface TournamentInput {
  readonly id?: string;
  readonly name?: string;
  readonly players: readonly Player[];
  readonly courts: number;
  readonly pointsPerMatch: number;
}
