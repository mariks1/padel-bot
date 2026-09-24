import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import type { Tournament } from "../src/domain";
import { formatTournamentResults } from "../src/bot/createBot";
import { TournamentService } from "../src/application/TournamentService";
import { SqliteTournamentRepository } from "../src/persistence/SqliteTournamentRepository";

for (const excludedIndex of [0, 2]) {
  test(`standings adjustment for team ${excludedIndex / 2 + 1} preserves other players and all lifetime statistics`, async () => {
    const database = new Database(":memory:");
    try {
      const repository = new SqliteTournamentRepository(database);
      const service = new TournamentService(repository);
      const players = await Promise.all(["Егор", "Катя", "Игорь", "Таня"].map((name) => service.createPlayer(name)));
      const tournament: Tournament = {
        id: "adjusted", name: "Test", players, courts: 1, pointsPerMatch: 24, createdAt: new Date(),
        rounds: [1, 2].map((number) => ({
          number, restingPlayers: [], matches: [{
            id: `r${number}-c1`, court: 1,
            team1: [players[0]!, players[1]!], team2: [players[2]!, players[3]!],
            pointsToPlay: 24, team1Score: 11, team2Score: 13,
          }],
        })),
      };
      await repository.save(tournament);
      const before = await Promise.all(players.map((player) => service.statisticsFor(player)));
      const leaderboardBefore = await service.leaderboard();
      const adjusted: Tournament = { ...tournament, rounds: tournament.rounds.map((round, index) =>
        index === 0 ? { ...round, matches: round.matches.map((match) => ({
          ...match, excludedFromStandingsPlayerIds: [players[excludedIndex]!.id],
        })) } : round),
      };
      await repository.save(adjusted);
      const reloaded = (await repository.findById(tournament.id))!;
      assert.deepEqual(reloaded, adjusted);
      for (const mode of ["current", "final"] as const) {
        const result = formatTournamentResults(reloaded, mode);
        for (const [index, player] of players.entries()) {
          const games = index === excludedIndex ? 1 : 2;
          const points = (index < 2 ? 11 : 13) * games;
          const difference = (index < 2 ? "-" : "+") + games * 2;
          const record = index < 2 ? `0-0-${games}` : `${games}-0-0`;
          assert.ok(result.includes(`${player.name} — ${points} очк. (${difference}), ${record}`));
        }
        assert.ok(result.includes(`Корректировка зачёта: ${players[excludedIndex]!.name} — исключено матчей: 1.`));
      }
      assert.deepEqual(await Promise.all(players.map((player) => service.statisticsFor(player))), before);
      assert.deepEqual(await service.leaderboard(), leaderboardBefore);
      // Editing a real score preserves the separate standings exclusion.
      const corrected = await service.recordScore(tournament.id, "r1-c1", 10, 14);
      assert.deepEqual(corrected.rounds[0]!.matches[0]!.excludedFromStandingsPlayerIds, [players[excludedIndex]!.id]);
      assert.equal((await service.statisticsFor(players[excludedIndex]!)).gamesPlayed, 2);
    } finally {
      database.close();
    }
  });
}
