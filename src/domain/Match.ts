import type { Player } from "./Player";

export type Team = readonly [Player, Player];

export interface Match {
  readonly id: string;
  readonly court: number;
  readonly team1: Team;
  readonly team2: Team;
  readonly pointsToPlay: number;
  team1Score?: number;
  team2Score?: number;
  /** Omit these players only from this tournament's standings; retain lifetime statistics. */
  readonly excludedFromStandingsPlayerIds?: readonly string[];
}
