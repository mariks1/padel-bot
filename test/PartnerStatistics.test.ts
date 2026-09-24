import assert from "node:assert/strict";
import { test } from "node:test";
import type { Match, Player, Tournament } from "../src/domain";
import { TournamentService } from "../src/application/TournamentService";
import { InMemoryTournamentRepository } from "../src/persistence/TournamentRepository";
import { formatStatistics, formatTournamentResults } from "../src/bot/createBot";

async function setup() {
  const repository = new InMemoryTournamentRepository();
  const service = new TournamentService(repository);
  const players = await Promise.all(["Анна", "Борис", "Вера", "Глеб"].map((name) => service.createPlayer(name)));
  const [anna, boris, vera, gleb] = players as [Player, Player, Player, Player];
  const save = async (id: string, matches: Match[]): Promise<Tournament> => {
    const tournament: Tournament = {
      id, name: id, players, courts: 1, pointsPerMatch: 24, createdAt: new Date(),
      rounds: matches.map((match, index) => ({ number: index + 1, matches: [match], restingPlayers: [] })),
    };
    await repository.save(tournament);
    return tournament;
  };
  const withBoris = await save("with-boris", [
    { id: "b1", court: 1, team1: [anna, boris], team2: [vera, gleb], pointsToPlay: 24, team1Score: 13, team2Score: 11 },
    { id: "b2", court: 1, team1: [vera, gleb], team2: [anna, boris], pointsToPlay: 24, team1Score: 11, team2Score: 13 },
    { id: "b3", court: 1, team1: [anna, boris], team2: [vera, gleb], pointsToPlay: 24 },
  ]);
  const withVera = await save("with-vera", [
    { id: "v1", court: 1, team1: [anna, vera], team2: [boris, gleb], pointsToPlay: 24, team1Score: 24, team2Score: 0 },
    { id: "v2", court: 1, team1: [anna, vera], team2: [boris, gleb], pointsToPlay: 24, team1Score: 10, team2Score: 14 },
    { id: "v3", court: 1, team1: [anna, vera], team2: [boris, gleb], pointsToPlay: 24, team1Score: 12, team2Score: 12 },
  ]);
  return { repository, service, players, anna, boris, vera, withBoris, withVera };
}

test("partner rankings distinguish win percentage from average points and ignore unplayed matches", async () => {
  const { service, anna, boris, vera } = await setup();
  const statistics = await service.statisticsFor(anna);
  assert.equal(statistics.gamesPlayed, 5);
  assert.equal(statistics.winRate, 70);
  assert.equal(statistics.bestPartnerByWinRate?.player.id, boris.id);
  assert.equal(statistics.bestPartnerByWinRate?.winRate, 100);
  assert.equal(statistics.bestPartnerByWinRate?.gamesPlayed, 2);
  assert.equal(statistics.bestPartnerByAveragePoints?.player.id, vera.id);
  assert.equal(statistics.bestPartnerByAveragePoints?.averagePointsFor, 46 / 3);
  assert.equal(statistics.bestPartnerByAveragePoints?.gamesPlayed, 3);
  assert.equal(statistics.bestPartnerByAveragePoints?.draws, 1);
  assert.equal(statistics.bestPartnerByAveragePoints?.losses, 1);
  assert.equal(statistics.bestPartnerByAveragePoints?.winRate, 50);
  const text = formatStatistics(statistics);
  assert.match(text, /Чаще всего побеждаешь с: Борис/);
  assert.match(text, /Винрейт: 70\.0% \(ничья = ½ победы\)/);
  assert.match(text, /Винрейт вместе: 100\.0% \(побед: 2, ничьих: 0, матчей: 2\)/);
  assert.match(text, /Больше всего очков в среднем с: Вера/);
  assert.match(text, /15\.3 очк\. за матч \(совместных матчей: 3\)/);
});

test("partner rankings reflect corrected results and renamed players", async () => {
  const { service, anna, vera, withBoris } = await setup();
  await service.recordScore(withBoris.id, "b1", 0, 24);
  await service.recordScore(withBoris.id, "b2", 24, 0);
  await service.renamePlayer(vera.id, "Мария");
  const statistics = await service.statisticsFor(anna);
  assert.equal(statistics.bestPartnerByWinRate?.player.name, "Мария");
  assert.equal(statistics.bestPartnerByAveragePoints?.player.name, "Мария");
});

test("draws count as half a win and a draws-only partner can lead the win-rate ranking", async () => {
  const { service, anna, vera, withBoris, withVera } = await setup();
  await service.recordScore(withBoris.id, "b2", 24, 0);
  for (const matchId of ["v1", "v2", "v3"]) {
    await service.recordScore(withVera.id, matchId, 12, 12);
  }
  const statistics = await service.statisticsFor(anna);
  assert.equal(statistics.wins, 1);
  assert.equal(statistics.draws, 3);
  assert.equal(statistics.losses, 1);
  assert.equal(statistics.winRate, 50);
  assert.equal(statistics.bestPartnerByWinRate?.player.id, vera.id);
  assert.equal(statistics.bestPartnerByWinRate?.winRate, 50);
  assert.equal(statistics.bestPartnerByWinRate?.wins, 0);
  assert.equal(statistics.bestPartnerByWinRate?.draws, 3);
  await service.cancel(withBoris.id);
  const drawsOnly = await service.statisticsFor(anna);
  assert.equal(drawsOnly.winRate, 50);
  assert.equal(drawsOnly.wins, 0);
  assert.equal(drawsOnly.draws, 3);
});

test("cancelling excludes all tournament results while retaining history and players", async () => {
  const { service, anna, boris, players, withVera, withBoris } = await setup();
  const cancelled = await service.cancel(withVera.id);
  assert.equal(cancelled.cancelled, true);
  assert.deepEqual(cancelled.rounds, withVera.rounds);
  assert.equal((await service.listTournaments()).length, 2);
  assert.deepEqual(await service.listPlayers(), [...players].sort((a, b) => a.name.localeCompare(b.name, "ru")));
  assert.deepEqual(await service.cancel(withVera.id), cancelled, "cancellation is idempotent");
  await assert.rejects(service.recordScore(withVera.id, "v1", 20, 4), /Турнир отменён/);
  const statistics = await service.statisticsFor(anna);
  assert.equal(statistics.gamesPlayed, 2);
  assert.equal(statistics.tournamentsPlayed, 1);
  assert.equal(statistics.pointsFor, 26);
  assert.equal(statistics.bestPartnerByAveragePoints?.player.id, boris.id);
  assert.equal(statistics.bestPartnerByAveragePoints?.averagePointsFor, 13);
  assert.match(formatTournamentResults(cancelled), /Турнир отменён/);
  assert.doesNotMatch(formatTournamentResults(cancelled), /Турнир завершён/);
  assert.match(formatTournamentResults(cancelled), /Результаты исключены/);
  await service.cancel(withBoris.id);
  await assert.rejects(service.recordScore(withBoris.id, "b3", 20, 4), /Турнир отменён/);
  const empty = await service.statisticsFor(anna);
  assert.equal(empty.gamesPlayed, 0);
  assert.equal(empty.winRate, 0);
  assert.equal(empty.bestPartnerByWinRate, undefined);
  assert.equal(empty.bestPartnerByAveragePoints, undefined);
  assert.ok((await service.leaderboard()).every((entry) => entry.gamesPlayed === 0 && entry.pointsFor === 0));
  assert.match(formatStatistics(empty), /пока нет сыгранных матчей/);
  await assert.rejects(service.cancel("missing"), /Турнир не найден/);
});
