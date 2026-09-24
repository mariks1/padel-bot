import type { Player, Round } from "../domain";
import { MatchScheduler } from "./MatchScheduler";
import { ScoringFunction } from "./ScoringFunction";

export class BalanceOptimizer {
  constructor(
    private readonly scheduler = new MatchScheduler(),
    private readonly scoring = new ScoringFunction(),
  ) {}

  generate(
    players: readonly Player[],
    courts: number,
    pointsToPlay: number,
  ): Round[] {
    const activeCount = Math.min(Math.floor(players.length / 4), courts) * 4;
    const restCount = players.length - activeCount;
    // A full rotation gives each player exactly activeCount games. When nobody
    // rests, the usual N - 1 rounds already give equal appearances.
    const roundCount = restCount === 0 ? players.length - 1 : players.length;
    const rounds: Round[] = [];

    for (let roundNumber = 1; roundNumber <= roundCount; roundNumber += 1) {
      let bestRound: Round | undefined;
      let bestScore = Number.POSITIVE_INFINITY;
      const restCandidates = this.restCandidates(players, rounds, restCount);

      for (const resting of restCandidates) {
        const restingIds = new Set(resting.map((player) => player.id));
        const active = players.filter((player) => !restingIds.has(player.id));
        const candidate = this.scheduler.findBestRound(
          active,
          resting,
          rounds,
          players,
          pointsToPlay,
          active.length <= 8 ? 1_200 : 350,
        );
        const score = this.scoring.evaluate([...rounds, candidate], players).total;
        if (score < bestScore || (score === bestScore && this.roundKey(candidate) < this.roundKey(bestRound!))) {
          bestScore = score;
          bestRound = candidate;
        }
      }

      if (!bestRound) throw new Error(`Unable to optimize round ${roundNumber}`);
      rounds.push(bestRound);
    }
    return rounds;
  }

  private restCandidates(
    players: readonly Player[],
    rounds: readonly Round[],
    restCount: number,
  ): Player[][] {
    if (restCount === 0) return [[]];

    const games = new Map(players.map((player) => [player.id, 0]));
    for (const round of rounds) {
      round.matches.flatMap((match) => [...match.team1, ...match.team2]).forEach(
        (player) => games.set(player.id, (games.get(player.id) ?? 0) + 1),
      );
    }

    // Only players with the most games may rest. Choosing among ties still
    // lets us optimize partnerships, but game counts can never differ by > 1.
    // Since the total appearances divide evenly, the final counts are equal.
    const ordered = [...players].sort((a, b) =>
      games.get(b.id)! - games.get(a.id)! || a.id.localeCompare(b.id));
    const cutoff = games.get(ordered[restCount - 1]!.id)!;
    const required = ordered.filter((player) => games.get(player.id)! > cutoff);
    const candidates = ordered.filter((player) => games.get(player.id) === cutoff);
    const chooseCount = restCount - required.length;
    const combinations: Player[][] = [];
    const build = (start: number, chosen: Player[]): void => {
      if (combinations.length >= 16) return;
      if (chosen.length === chooseCount) {
        combinations.push([...required, ...chosen]);
        return;
      }
      for (let index = start; index <= candidates.length - (chooseCount - chosen.length); index += 1) {
        build(index + 1, [...chosen, candidates[index]!]);
        if (combinations.length >= 16) break;
      }
    };
    build(0, []);

    return combinations;
  }

  private roundKey(round: Round): string {
    return round.matches
      .flatMap((match) => [...match.team1, ...match.team2])
      .map((player) => player.id)
      .join("|");
  }
}
