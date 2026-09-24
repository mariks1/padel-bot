import type { Player, Team } from "../domain";

export const pairKey = (a: Player, b: Player): string =>
  [a.id, b.id].sort().join("::");

/** Generates the one-factorization of a complete graph (Circle Method). */
export class PairGenerator {
  generateCirclePairs(players: readonly Player[]): Team[][] {
    if (players.length < 4 || players.length % 2 !== 0) {
      throw new Error("Circle Method requires an even number of at least 4 players");
    }

    const wheel = [...players];
    const result: Team[][] = [];

    for (let round = 0; round < players.length - 1; round += 1) {
      const teams: Team[] = [];
      for (let i = 0; i < wheel.length / 2; i += 1) {
        teams.push([wheel[i]!, wheel[wheel.length - 1 - i]!] as const);
      }
      result.push(teams);

      const fixed = wheel[0]!;
      const rest = wheel.slice(1);
      rest.unshift(rest.pop()!);
      wheel.splice(0, wheel.length, fixed, ...rest);
    }

    return result;
  }

  rankPartners(
    player: Player,
    candidates: readonly Player[],
    partnerCounts: ReadonlyMap<string, number>,
  ): Player[] {
    return [...candidates].sort((a, b) => {
      const countDifference =
        (partnerCounts.get(pairKey(player, a)) ?? 0) -
        (partnerCounts.get(pairKey(player, b)) ?? 0);
      return countDifference || a.id.localeCompare(b.id);
    });
  }
}
