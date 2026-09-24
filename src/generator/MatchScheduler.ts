import type { Match, Player, Round, Team } from "../domain";
import { pairKey, PairGenerator } from "./PairGenerator";
import { ScoringFunction } from "./ScoringFunction";

type MatchTeams = readonly [Team, Team];

export class MatchScheduler {
  constructor(
    private readonly scoring = new ScoringFunction(),
    private readonly pairGenerator = new PairGenerator(),
  ) {}

  /** Pack existing matches into rounds without adding games to fill spare courts. */
  packRounds(
    cycles: readonly Round[],
    players: readonly Player[],
    courts: number,
    pointsToPlay: number,
  ): Round[] {
    const capacity = Math.min(courts, Math.floor(players.length / 4));
    if (capacity === players.length / 4) return [...cycles];

    const matches: MatchTeams[] = cycles.flatMap((round) =>
      round.matches.map((match) => [match.team1, match.team2] as const),
    );
    const playerIndices = new Map(players.map((player, index) => [player.id, index]));
    const masks = matches.map((match) => match.flat().reduce(
      (mask, player) => mask | (1 << playerIndices.get(player.id)!), 0,
    ));

    // Fix one match in each group to avoid exploring permutations of the same rounds.
    // Backtrack when a choice leaves conflicting players in the remaining matches.
    const pack = (remaining: readonly number[]): MatchTeams[][] | undefined => {
      if (remaining.length === 0) return [];
      const size = Math.min(capacity, remaining.length);
      const choose = (start: number, group: number[], occupied: number): MatchTeams[][] | undefined => {
        if (group.length === size) {
          const selected = new Set(group);
          const tail = pack(remaining.filter((index) => !selected.has(index)));
          return tail ? [group.map((index) => matches[index]!), ...tail] : undefined;
        }
        for (let position = start; position < remaining.length; position += 1) {
          const index = remaining[position]!;
          if ((occupied & masks[index]!) !== 0) continue;
          const result = choose(position + 1, [...group, index], occupied | masks[index]!);
          if (result) return result;
        }
        return undefined;
      };
      const first = remaining[0]!;
      return choose(1, [first], masks[first]!);
    };

    const groups = pack(matches.map((_, index) => index));
    if (!groups) throw new Error("Unable to pack matches into full rounds");
    const rounds: Round[] = [];
    const makeRound = (group: readonly MatchTeams[]): Round => {
      const playing = new Set(group.flat(2).map((player) => player.id));
      return this.toRound(group, rounds.length + 1,
        players.filter((player) => !playing.has(player.id)), pointsToPlay);
    };

    // Order complete groups by games/rest balance; leave any partial group last.
    while (groups.length > 0) {
      let bestIndex = 0;
      let bestScore = Number.POSITIVE_INFINITY;
      for (let index = 0; index < groups.length; index += 1) {
        const group = groups[index]!;
        if (group.length < capacity && groups.length > 1) continue;
        const score = this.scoring.evaluate([...rounds, makeRound(group)], players).total;
        if (score < bestScore) {
          bestScore = score;
          bestIndex = index;
        }
      }
      const group = groups.splice(bestIndex, 1)[0]!;
      rounds.push(makeRound(group));
    }
    return rounds;
  }

  pairTeams(
    teams: readonly Team[],
    previousRounds: readonly Round[],
    players: readonly Player[],
  ): MatchTeams[] {
    let best: MatchTeams[] | undefined;
    let bestScore = Number.POSITIVE_INFINITY;

    const visit = (remaining: readonly Team[], matches: MatchTeams[]): void => {
      if (remaining.length === 0) {
        const candidate = this.toRound(matches, previousRounds.length + 1, [], 32);
        const score = this.scoring.evaluate([...previousRounds, candidate], players).total;
        if (score < bestScore) {
          bestScore = score;
          best = matches.map((match) => match);
        }
        return;
      }
      const first = remaining[0]!;
      for (let i = 1; i < remaining.length; i += 1) {
        const opponent = remaining[i]!;
        visit(
          remaining.filter((_, index) => index !== 0 && index !== i),
          [...matches, [first, opponent]],
        );
      }
    };
    visit(teams, []);
    return best ?? [];
  }

  findBestRound(
    activePlayers: readonly Player[],
    restingPlayers: readonly Player[],
    previousRounds: readonly Round[],
    allPlayers: readonly Player[],
    pointsToPlay: number,
    maxCandidates = 6_000,
  ): Round {
    const partnerCounts = this.partnerCounts(previousRounds);
    let examined = 0;
    let best: Round | undefined;
    let bestScore = Number.POSITIVE_INFINITY;

    const visit = (remaining: readonly Player[], matches: MatchTeams[]): void => {
      if (examined >= maxCandidates) return;
      if (remaining.length === 0) {
        examined += 1;
        const candidate = this.toRound(
          matches,
          previousRounds.length + 1,
          restingPlayers,
          pointsToPlay,
        );
        const score = this.scoring.evaluate([...previousRounds, candidate], allPlayers).total;
        if (score < bestScore) {
          bestScore = score;
          best = candidate;
        }
        return;
      }

      const first = remaining[0]!;
      const partners = this.pairGenerator.rankPartners(first, remaining.slice(1), partnerCounts);
      for (const partner of partners) {
        const afterTeam = remaining.filter((player) => player !== first && player !== partner);
        for (let i = 0; i < afterTeam.length; i += 1) {
          for (let j = i + 1; j < afterTeam.length; j += 1) {
            const opponents: Team = [afterTeam[i]!, afterTeam[j]!] as const;
            visit(
              afterTeam.filter((_, index) => index !== i && index !== j),
              [...matches, [[first, partner] as const, opponents]],
            );
            if (examined >= maxCandidates) return;
          }
        }
      }
    };

    visit(activePlayers, []);
    if (!best) throw new Error("Unable to construct a valid round");
    return best;
  }

  toRound(
    matches: readonly MatchTeams[],
    number: number,
    restingPlayers: readonly Player[],
    pointsToPlay: number,
  ): Round {
    return {
      number,
      matches: matches.map(([team1, team2], index): Match => ({
        id: `r${number}-c${index + 1}`,
        court: index + 1,
        team1,
        team2,
        pointsToPlay,
      })),
      restingPlayers: [...restingPlayers],
    };
  }

  private partnerCounts(rounds: readonly Round[]): Map<string, number> {
    const result = new Map<string, number>();
    for (const round of rounds) {
      for (const match of round.matches) {
        for (const team of [match.team1, match.team2]) {
          const key = pairKey(team[0], team[1]);
          result.set(key, (result.get(key) ?? 0) + 1);
        }
      }
    }
    return result;
  }
}
