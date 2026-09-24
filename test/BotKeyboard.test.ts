import assert from "node:assert/strict";
import { test } from "node:test";
import { createScoreKeyboard, formatTournamentResults } from "../src/bot/createBot";
import type { Tournament } from "../src/domain";

test("creates all 24-point score buttons in five-column rows", () => {
  const rows = createScoreKeyboard(24).inline_keyboard;
  assert.deepEqual(rows.map((row) => row.length), [5, 5, 5, 5, 5, 1]);

  const scoreButtons = rows.slice(0, -1).flat();
  assert.equal(scoreButtons.length, 25);
  assert.equal(scoreButtons[0]?.text, "0:24");
  assert.equal(scoreButtons[12]?.text, "12:12");
  assert.equal(scoreButtons[24]?.text, "24:0");
  assert.deepEqual(
    scoreButtons.map((button) => "callback_data" in button ? button.callback_data : undefined),
    Array.from({ length: 25 }, (_, score) => `score-value:${score}`),
  );
  assert.equal(rows.at(-1)?.[0]?.text, "🏠 Главное меню");
});

test("creates score correction callbacks and a back button", () => {
  const tournamentId = "12345678-1234-1234-1234-123456789012";
  const rows = createScoreKeyboard(
    24,
    (score) => `history:set:${tournamentId}:r120-c1:${score}`,
    { text: "⬅️ Без изменений", callbackData: `history:games:${tournamentId}:120` },
  ).inline_keyboard;
  const callbackData = rows.flat().map((button) =>
    "callback_data" in button ? button.callback_data : ""
  );

  assert.ok(callbackData.every((value) => Buffer.byteLength(value) <= 64));
  assert.equal(rows.at(-1)?.[0]?.text, "⬅️ Без изменений");
});

test("formats final tournament standings by scored points", () => {
  const players = ["Анна", "Борис", "Вера", "Глеб"].map((name, index) => ({
    id: String(index + 1),
    name,
  }));
  const tournament: Tournament = {
    id: "tournament",
    name: "Americano",
    players,
    courts: 1,
    pointsPerMatch: 24,
    createdAt: new Date("2026-01-01"),
    rounds: [{
      number: 1,
      restingPlayers: [],
      matches: [{
        id: "r1-c1",
        court: 1,
        team1: [players[0]!, players[1]!],
        team2: [players[2]!, players[3]!],
        pointsToPlay: 24,
        team1Score: 15,
        team2Score: 9,
      }],
    }],
  };

  const result = formatTournamentResults(tournament);
  assert.match(result, /Турнир завершён/);
  assert.match(result, /1\. Анна — 15 очк\. \(\+6\), 1-0-0/);
  assert.match(result, /3\. Вера — 9 очк\. \(-6\), 0-0-1/);

  const current = formatTournamentResults(tournament, "current");
  assert.match(current, /Текущий турнир/);
  assert.match(current, /Сыграно матчей: 1 из 1/);
});
