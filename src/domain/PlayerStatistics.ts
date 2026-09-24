import type { Player } from "./Player";

export interface PartnerStatistics {
  readonly player: Player;
  readonly gamesPlayed: number;
  readonly wins: number;
  readonly draws: number;
  readonly losses: number;
  readonly pointsFor: number;
  readonly pointsAgainst: number;
  readonly winRate: number;
  readonly averagePointsFor: number;
}

export interface PlayerStatistics {
  readonly player: Player;
  readonly tournamentsPlayed: number;
  readonly gamesPlayed: number;
  readonly wins: number;
  readonly draws: number;
  readonly losses: number;
  readonly pointsFor: number;
  readonly pointsAgainst: number;
  readonly pointsDifference: number;
  readonly averagePointsFor: number;
  readonly averagePointsAgainst: number;
  readonly winRate: number;
  readonly uniquePartners: number;
  readonly uniqueOpponents: number;
  readonly bestPartnerByWinRate?: PartnerStatistics;
  readonly bestPartnerByAveragePoints?: PartnerStatistics;
}
