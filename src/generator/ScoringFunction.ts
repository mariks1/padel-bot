import type { Match, Player, Round } from "../domain";
import { pairKey } from "./PairGenerator";

export interface ScheduleMetrics {
  partnerRepeats: number;
  opponentRepeats: number;
  matchRepeats: number;
  restImbalance: number;
  gamesImbalance: number;
  newPartnerships: number;
  newOpponentPairs: number;
}

export interface ScheduleScore extends ScheduleMetrics {
  total: number;
}

const matchKey = (match: Match): string => {
  const teams = [
    pairKey(match.team1[0], match.team1[1]),
    pairKey(match.team2[0], match.team2[1]),
  ].sort();
  return teams.join(" vs ");
};

const increment = (map: Map<string, number>, key: string): number => {
  const previous = map.get(key) ?? 0;
  map.set(key, previous + 1);
  return previous;
};

export class ScoringFunction {
  evaluate(rounds: readonly Round[], players: readonly Player[]): ScheduleScore {
    const partners = new Map<string, number>();
    const opponents = new Map<string, number>();
    const matches = new Map<string, number>();
    const games = new Map(players.map((player) => [player.id, 0]));
    const rests = new Map(players.map((player) => [player.id, 0]));
    let partnerRepeats = 0;
    let opponentRepeats = 0;
    let matchRepeats = 0;
    let newPartnerships = 0;
    let newOpponentPairs = 0;

    for (const round of rounds) {
      for (const player of round.restingPlayers) {
        rests.set(player.id, (rests.get(player.id) ?? 0) + 1);
      }
      for (const match of round.matches) {
        const playersInMatch = [...match.team1, ...match.team2];
        playersInMatch.forEach((player) => games.set(player.id, (games.get(player.id) ?? 0) + 1));

        for (const team of [match.team1, match.team2]) {
          if (increment(partners, pairKey(team[0], team[1])) > 0) partnerRepeats += 1;
          else newPartnerships += 1;
        }
        for (const left of match.team1) {
          for (const right of match.team2) {
            if (increment(opponents, pairKey(left, right)) > 0) opponentRepeats += 1;
            else newOpponentPairs += 1;
          }
        }
        if (increment(matches, matchKey(match)) > 0) matchRepeats += 1;
      }
    }

    const spread = (values: Iterable<number>): number => {
      const all = [...values];
      return all.length === 0 ? 0 : Math.max(...all) - Math.min(...all);
    };
    const restImbalance = spread(rests.values());
    const gamesImbalance = spread(games.values());

    return {
      partnerRepeats,
      opponentRepeats,
      matchRepeats,
      restImbalance,
      gamesImbalance,
      newPartnerships,
      newOpponentPairs,
      total:
        partnerRepeats * 1_000 +
        matchRepeats * 500 +
        opponentRepeats * 25 +
        restImbalance * 250 +
        gamesImbalance * 250 -
        newPartnerships * 8 -
        newOpponentPairs,
    };
  }
}
