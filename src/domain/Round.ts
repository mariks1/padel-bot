import type { Match } from "./Match";
import type { Player } from "./Player";

export interface Round {
  readonly number: number;
  readonly matches: readonly Match[];
  readonly restingPlayers: readonly Player[];
}
