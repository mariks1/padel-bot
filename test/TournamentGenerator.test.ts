import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Player, Tournament } from "../src/domain";
import { pairKey, TournamentGenerator } from "../src/generator";

const players = (count: number): Player[] => Array.from({ length: count }, (_, index) => ({
  id: String(index + 1).padStart(2, "0"),
  name: `Player ${index + 1}`,
}));

const generate = (count: number, courts: number): Tournament => new TournamentGenerator().generate({
  id: `test-${count}`,
  players: players(count),
  courts,
  pointsPerMatch: 32,
});

const partnershipCounts = (tournament: Tournament): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const round of tournament.rounds) {
    for (const match of round.matches) {
      for (const team of [match.team1, match.team2]) {
        const key = pairKey(team[0], team[1]);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  }
  return counts;
};

const appearances = (tournament: Tournament): number[] => tournament.players.map((player) =>
  tournament.rounds.reduce((total, round) => total + round.matches.filter((match) =>
    [...match.team1, ...match.team2].some((candidate) => candidate.id === player.id),
  ).length, 0),
);

describe("perfect Circle Method schedules", () => {
  for (const count of [4, 8, 12]) {
    test(`${count} players partner every other player exactly once`, () => {
      const tournament = generate(count, count / 4);
      assert.equal(tournament.rounds.length, count - 1);
      assert.equal(
        tournament.rounds.reduce((sum, round) => sum + round.matches.length, 0),
        (count * (count - 1)) / 4,
      );
      assert.equal(partnershipCounts(tournament).size, (count * (count - 1)) / 2);
      assert.ok([...partnershipCounts(tournament).values()].every((value) => value === 1));
      assert.ok(tournament.rounds.every((round) => round.restingPlayers.length === 0));
      assert.deepEqual(new Set(appearances(tournament)), new Set([count - 1]));
    });
  }
});

describe("optimized schedule", () => {
  for (const courts of [2, 3]) {
    test(`11 players / ${courts} courts: eight games each, unique partners and spaced rests`, () => {
      const tournament = generate(11, courts);
      assert.equal(tournament.rounds.length, 11);
      assert.equal(tournament.rounds.flatMap((round) => round.matches).length, 22);
      assert.deepEqual(appearances(tournament), Array(11).fill(8));
      const partnerships = partnershipCounts(tournament);
      assert.equal(partnerships.size, 44);
      assert.ok([...partnerships.values()].every((count) => count === 1));

      const matchIds = new Set<string>();
      for (const [index, round] of tournament.rounds.entries()) {
        assert.equal(round.number, index + 1);
        assert.equal(round.matches.length, 2);
        assert.equal(round.restingPlayers.length, 3);
        assert.deepEqual(round.matches.map((match) => match.court), [1, 2]);
        const participants = [
          ...round.restingPlayers,
          ...round.matches.flatMap((match) => [...match.team1, ...match.team2]),
        ];
        assert.deepEqual(participants.map((player) => player.id).sort(), players(11).map((player) => player.id));
        const previousRestingIds = new Set(tournament.rounds[index - 1]?.restingPlayers.map((player) => player.id));
        assert.ok(round.restingPlayers.every((player) => !previousRestingIds.has(player.id)),
          "no player should rest two rounds in a row");
        for (const match of round.matches) {
          assert.equal(match.pointsToPlay, 32);
          assert.ok(!matchIds.has(match.id));
          matchIds.add(match.id);
        }
      }
      for (const player of tournament.players) {
        const rests = tournament.rounds.flatMap((round, index) =>
          round.restingPlayers.some((resting) => resting.id === player.id) ? [index] : []);
        assert.equal(rests.length, 3);
        const gaps = rests.map((round, index) =>
          (rests[(index + 1) % rests.length]! - round + 11) % 11);
        assert.deepEqual(gaps.sort(), [3, 4, 4]);
      }
    });
  }

  test("12 players on two courts finish with one match so everyone plays exactly 11 games", () => {
    const tournament = generate(12, 2);
    const partnerships = partnershipCounts(tournament);
    const games = appearances(tournament);

    assert.equal(tournament.rounds.length, 17);
    assert.equal(tournament.rounds.flatMap((round) => round.matches).length, 33);
    assert.ok(tournament.rounds.slice(0, 16).every((round) => round.matches.length === 2));
    assert.ok(tournament.rounds.slice(0, 16).every((round) => round.restingPlayers.length === 4));
    const last = tournament.rounds[16]!;
    assert.equal(last.matches.length, 1);
    assert.equal(last.restingPlayers.length, 8);
    assert.equal(partnerships.size, 66, "every pair must still play together");
    assert.ok([...partnerships.values()].every((count) => count === 1));
    assert.deepEqual(games, Array(12).fill(11));
    const beforeFinal = appearances({ ...tournament, rounds: tournament.rounds.slice(0, 16) });
    assert.equal(beforeFinal.filter((count) => count === 11).length, 8);
    assert.equal(beforeFinal.filter((count) => count === 10).length, 4);
    const finalPlayers = new Set(last.matches.flatMap((match) => [...match.team1, ...match.team2]).map((player) => player.id));
    tournament.players.forEach((player, index) => {
      assert.equal(finalPlayers.has(player.id), beforeFinal[index] === 10);
    });
  });

  for (const count of [4, 8, 12, 16]) {
    for (let courts = 1; courts <= count / 4 + 1; courts += 1) {
      test(`${count} players / ${courts} courts: compact, valid schedule`, () => {
        const tournament = generate(count, courts);
        const capacity = Math.min(courts, count / 4);
        assert.equal(tournament.rounds.length, Math.ceil(count * (count - 1) / 4 / capacity));
        const matchIds = new Set<string>();
        for (const [index, round] of tournament.rounds.entries()) {
          assert.equal(round.number, index + 1);
          const remainingMatches = count * (count - 1) / 4 - index * capacity;
          assert.equal(round.matches.length, Math.min(capacity, remainingMatches));
          assert.deepEqual(round.matches.map((match) => match.court),
            Array.from({ length: round.matches.length }, (_, i) => i + 1));
          const active = round.matches.flatMap((match) => [...match.team1, ...match.team2]);
          const allIds = [...active, ...round.restingPlayers].map((player) => player.id);
          assert.equal(allIds.length, count);
          assert.equal(new Set(allIds).size, count, "no player can play twice or rest while playing");
          assert.deepEqual([...allIds].sort(), players(count).map((player) => player.id));
          for (const match of round.matches) {
            assert.equal(match.pointsToPlay, 32);
            assert.ok(!matchIds.has(match.id));
            matchIds.add(match.id);
          }
        }
        assert.equal(partnershipCounts(tournament).size, count * (count - 1) / 2);
        const games = appearances(tournament);
        assert.deepEqual(games, Array(count).fill(count - 1));
        assert.ok([...partnershipCounts(tournament).values()].every((value) => value === 1));
      });
    }
  }

  test("10 players have fair rests and games on two courts", () => {
    const tournament = generate(10, 2);
    const games = appearances(tournament);
    const rests = tournament.players.map((player) => tournament.rounds.filter((round) =>
      round.restingPlayers.some((candidate) => candidate.id === player.id),
    ).length);

    assert.equal(tournament.rounds.length, 10);
    assert.equal(tournament.rounds.reduce((sum, round) => sum + round.matches.length, 0), 20);
    assert.ok(tournament.rounds.every((round) => round.restingPlayers.length === 2));
    assert.deepEqual(rests, Array(10).fill(2));
    assert.deepEqual(games, Array(10).fill(8));
  });

  for (const count of [5, 6, 7, 9, 10, 11, 13, 14, 15]) {
    for (let courts = 1; courts <= Math.floor(count / 4) + 1; courts += 1) {
      test(`${count} players / ${courts} courts: all players finish with equal games`, () => {
        const tournament = generate(count, courts);
        const capacity = Math.min(courts, Math.floor(count / 4));
        assert.deepEqual(appearances(tournament), Array(count).fill(capacity * 4));
        assert.equal(tournament.rounds.length, count);
        for (const round of tournament.rounds) {
          assert.equal(round.matches.length, capacity);
          const participants = [
            ...round.restingPlayers,
            ...round.matches.flatMap((match) => [...match.team1, ...match.team2]),
          ];
          assert.deepEqual(participants.map((player) => player.id).sort(), players(count).map((player) => player.id));
        }
      });
    }
  }
});
