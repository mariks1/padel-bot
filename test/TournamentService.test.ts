import assert from "node:assert/strict";
import { test } from "node:test";
import { TournamentService } from "../src/application/TournamentService";
import { InMemoryTournamentRepository } from "../src/persistence/TournamentRepository";

test("one final match completes the 12-player tournament with equal statistics", async () => {
  const service = new TournamentService(new InMemoryTournamentRepository());
  const players = await Promise.all(Array.from({ length: 12 }, (_, index) =>
    service.createPlayer(`Player ${index + 1}`)));
  const tournament = await service.create({ players, courts: 2, pointsPerMatch: 24 });
  for (const round of tournament.rounds.slice(0, -1)) {
    for (const match of round.matches) {
      await service.recordScore(tournament.id, match.id, 12, 12);
    }
  }

  const pending = (await service.findById(tournament.id))!.rounds
    .flatMap((round) => round.matches).filter((match) => match.team1Score === undefined);
  assert.equal(pending.length, 1);
  const completed = await service.recordScore(tournament.id, pending[0]!.id, 12, 12);
  assert.ok(completed.rounds.flatMap((round) => round.matches)
    .every((match) => match.team1Score !== undefined && match.team2Score !== undefined));
  for (const player of players) {
    const statistics = await service.statisticsFor(player);
    assert.equal(statistics.gamesPlayed, 11);
    assert.equal(statistics.uniquePartners, 11);
    assert.equal(statistics.pointsFor, 132);
  }
});

test("stores players, recognizes Telegram and calculates scored-match statistics", async () => {
  const service = new TournamentService(new InMemoryTournamentRepository());
  const players = await Promise.all([
    service.createPlayer("Анна", { userId: 101, username: "anna" }),
    service.createPlayer("Борис"),
    service.createPlayer("Вера"),
    service.createPlayer("Глеб"),
  ]);
  const recognized = await service.recognizePlayer(101, "anna");
  assert.equal(recognized?.name, "Анна");

  const tournament = await service.create({ players, courts: 1, pointsPerMatch: 32 });
  const matchId = tournament.rounds[0]!.matches[0]!.id;
  await service.recordScore(tournament.id, matchId, 20, 12);
  const statistics = await service.statisticsFor(players[0]!);

  assert.equal(statistics.tournamentsPlayed, 1);
  assert.equal(statistics.gamesPlayed, 1);
  assert.equal(statistics.pointsFor + statistics.pointsAgainst, 32);
  assert.equal(statistics.uniquePartners, 1);
  assert.equal(statistics.uniqueOpponents, 2);

  const corrected = await service.recordScore(tournament.id, matchId, 18, 14);
  assert.equal(corrected.rounds[0]!.matches[0]!.team1Score, 18);
  assert.equal((await service.listTournaments()).length, 1);

  assert.equal(await service.egorMistakes(), 0);
  assert.equal(await service.addEgorMistakes(3), 3);
  assert.equal(await service.addEgorMistakes(2), 5);

  const renamed = await service.renamePlayer(players[0]!.id, "  Мария  ");
  assert.equal(renamed.name, "Мария");
  assert.equal((await service.listPlayers()).find((player) => player.id === renamed.id)?.name, "Мария");
  const renamedTournament = await service.findById(tournament.id);
  const tournamentNames = renamedTournament!.rounds.flatMap((round) => [
    ...round.restingPlayers,
    ...round.matches.flatMap((match) => [...match.team1, ...match.team2]),
  ]).filter((player) => player.id === renamed.id).map((player) => player.name);
  assert.ok(tournamentNames.length > 0);
  assert.ok(tournamentNames.every((name) => name === "Мария"));
});
