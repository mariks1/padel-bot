import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import { createBot } from "../src/bot/createBot";
import { TournamentService } from "../src/application/TournamentService";
import { InMemoryTournamentRepository } from "../src/persistence/TournamentRepository";
import { SqliteTournamentRepository } from "../src/persistence/SqliteTournamentRepository";

test("bot exposes partner statistics and cancellation, and rejects old score buttons", async () => {
  const service = new TournamentService(new InMemoryTournamentRepository());
  const players = await Promise.all(["Анна", "Борис", "Вера", "Глеб"].map((name) => service.createPlayer(name)));
  const tournament = await service.create({ players, courts: 1, pointsPerMatch: 24 });
  const first = tournament.rounds[0]!.matches[0]!;
  const unplayed = tournament.rounds[1]!.matches[0]!;
  await service.recordScore(tournament.id, first.id, 15, 9);
  const bot = createBot("123:test", service);
  bot.botInfo = {
    id: 123, is_bot: true, first_name: "Test", username: "test_bot",
    can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false,
    can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false,
    allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false,
  };
  const calls: { method: string; payload: Record<string, any> }[] = [];
  bot.api.config.use(async (_previous, method, payload) => {
    calls.push({ method, payload });
    // Telegram is fully mocked: no test sends a message or makes a network call.
    const result: any = method === "sendMessage" || method === "editMessageText"
      ? { message_id: 200, date: 0, chat: { id: 1, type: "private" }, text: "test" }
      : true;
    return { ok: true, result };
  });
  let updateId = 0;
  const click = async (data: string): Promise<void> => {
    calls.length = 0;
    await bot.handleUpdate({
      update_id: ++updateId,
      callback_query: {
        id: String(updateId), data, chat_instance: "test",
        from: { id: 1, is_bot: false, first_name: "Test" },
        message: { message_id: 200, date: 1, chat: { id: 1, type: "private", first_name: "Test" }, text: "test" },
      },
    });
    for (const call of calls) {
      for (const row of call.payload.reply_markup?.inline_keyboard ?? []) {
        for (const button of row) {
          if (button.callback_data) assert.ok(Buffer.byteLength(button.callback_data) <= 64);
        }
      }
    }
  };
  const buttons = (): string[] => calls.flatMap((call) =>
    (call.payload.reply_markup?.inline_keyboard ?? []).flat().map((button: { callback_data: string }) => button.callback_data));
  const text = (): string => calls.map((call) => call.payload.text ?? "").join("\n");
  const message = async (value: string): Promise<void> => {
    calls.length = 0;
    await bot.handleUpdate({ update_id: ++updateId, message: {
      message_id: updateId, date: 1, chat: { id: 1, type: "private", first_name: "Test" },
      from: { id: 1, is_bot: false, first_name: "Test" }, text: value,
      entities: value.startsWith("/") ? [{ type: "bot_command", offset: 0, length: value.split(" ")[0]!.length }] : [],
    } });
  };

  await click("menu:statistics");
  assert.deepEqual(buttons(), ["statistics:search", "menu:main"]);
  await click("statistics:search");
  await message("никого с таким именем");
  assert.match(text(), /Игрок не найден/);
  await message("бор");
  assert.match(text(), /📊 Борис/);
  const anotherAnna = await service.createPlayer("Анна другая", { username: "another_anna" });
  await message("/stats @ANOTHER_ANNA");
  assert.match(text(), /📊 Анна другая/);
  assert.match(text(), /Матчи: 0/);
  await message("/stats АННА");
  assert.match(text(), /📊 Анна\n/);
  await message("/stats");
  assert.match(text(), /Введи имя игрока/);
  await message("ан");
  assert.match(text(), /Нашлось несколько игроков/);
  assert.match(text(), /1\. Анна\n2\. Анна другая/);
  assert.deepEqual(buttons(), ["menu:statistics", "menu:main"]);
  await message("9");
  assert.match(text(), /Введи номер от 1 до 2/);
  await message("2");
  assert.match(text(), /📊 Анна другая/);
  await click("statistics:search");
  await click("menu:statistics");
  await message("Борис");
  assert.doesNotMatch(text(), /📊 Борис/, "leaving search should clear its pending input");
  assert.equal((await service.listPlayers()).find((player) => player.id === anotherAnna.id)?.name, "Анна другая");
  await click(`statistics:player:${first.team1[0].id}`);
  assert.match(text(), /Чаще всего побеждаешь с/);
  assert.match(text(), /Больше всего очков в среднем с/);
  await click("menu:current");
  assert.ok(buttons().includes(`cancel:ask:${tournament.id}`));
  await click(`cancel:ask:${tournament.id}`);
  assert.ok(buttons().includes(`cancel:confirm:${tournament.id}`));
  assert.ok(!(await service.findById(tournament.id))!.cancelled, "asking alone must not cancel");
  await click(`cancel:confirm:${tournament.id}`);
  assert.equal((await service.findById(tournament.id))!.cancelled, true);
  assert.match(text(), /Турнир отменён/);
  assert.ok(!buttons().some((button) => button.startsWith("cancel:")));
  await click("menu:current");
  assert.match(text(), /нет незавершённого турнира/);
  await click(`current:continue:${tournament.id}`);
  assert.match(text(), /Турнир отменён/);
  assert.ok(!buttons().some((button) => button.startsWith("result:")));
  await click(`result:${tournament.id}:${unplayed.id}:20`);
  assert.match(text(), /Турнир отменён/);
  await click(`history:set:${tournament.id}:${first.id}:20`);
  assert.match(text(), /Турнир отменён/);
  await click(`history:edit:${tournament.id}:${first.id}`);
  assert.ok(!buttons().some((button) => button.startsWith("history:set:") || button.startsWith("history:edit:")));
  const stored = (await service.findById(tournament.id))!;
  assert.equal(stored.rounds[0]!.matches[0]!.team1Score, 15);
  assert.equal(stored.rounds[1]!.matches[0]!.team1Score, undefined);
});

test("cancelled status survives SQLite serialization and old tournaments remain readable", async () => {
  const database = new Database(":memory:");
  try {
    const service = new TournamentService(new SqliteTournamentRepository(database));
    const players = await Promise.all(["A", "B", "C", "D"].map((name) => service.createPlayer(name)));
    const tournament = await service.create({ players, courts: 1, pointsPerMatch: 24 });
    const first = tournament.rounds[0]!.matches[0]!;
    await service.recordScore(tournament.id, first.id, 15, 9);
    assert.equal((await service.findById(tournament.id))!.cancelled, undefined);
    await service.cancel(tournament.id);
    const reloaded = new TournamentService(new SqliteTournamentRepository(database));
    const saved = (await reloaded.findById(tournament.id))!;
    assert.equal(saved.cancelled, true);
    assert.equal(saved.rounds[0]!.matches[0]!.team1Score, 15);
    assert.equal((await reloaded.statisticsFor(players[0]!)).gamesPlayed, 0);
    assert.equal((await reloaded.listPlayers()).length, 4);
    await assert.rejects(reloaded.recordScore(tournament.id, first.id, 20, 4), /Турнир отменён/);
  } finally {
    database.close();
  }
});
