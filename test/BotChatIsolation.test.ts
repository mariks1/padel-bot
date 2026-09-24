import assert from "node:assert/strict";
import { test } from "node:test";
import { createBot } from "../src/bot/createBot";
import { TournamentService } from "../src/application/TournamentService";
import { InMemoryTournamentRepository } from "../src/persistence/TournamentRepository";

test("private menus, input and player selection do not change the same user's group session", async () => {
  const service = new TournamentService(new InMemoryTournamentRepository());
  const players = await Promise.all(["A", "B", "C", "D"].map((name, index) =>
    service.createPlayer(name, index === 0 ? { userId: 1 } : undefined)));
  const tournament = await service.create({ players, courts: 1, pointsPerMatch: 24 });
  const bot = createBot("123:test", service);
  bot.botInfo = {
    id: 123, is_bot: true, first_name: "Test", username: "test_bot",
    can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false,
    can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false,
    allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false,
  };
  const group = -100;
  const privateChat = 1;
  const chat = (id: number) => id < 0
    ? { id, type: "supergroup" as const, title: "Group" }
    : { id, type: "private" as const, first_name: "Test" };
  const calls: { method: string; payload: Record<string, any>; messageId?: number }[] = [];
  let nextMessageId = 1000;
  let updateId = 0;
  bot.api.config.use(async (_previous, method, payload) => {
    const data = payload as Record<string, any>;
    const messageId = method === "sendMessage" ? ++nextMessageId : data.message_id;
    calls.push({ method, payload: data, messageId });
    const result: any = method === "sendMessage" || method === "editMessageText"
      ? { message_id: messageId, date: 1, chat: chat(Number(data.chat_id)), text: data.text }
      : true;
    return { ok: true, result };
  });
  const from = { id: 1, is_bot: false, first_name: "Test" };
  const click = async (chatId: number, data: string) => {
    calls.length = 0;
    await bot.handleUpdate({ update_id: ++updateId, callback_query: {
      id: String(updateId), data, chat_instance: String(chatId), from,
      message: { message_id: 200, date: 1, chat: chat(chatId), text: "menu" },
    } });
  };
  const message = async (chatId: number, text: string) => {
    calls.length = 0;
    await bot.handleUpdate({ update_id: ++updateId, message: {
      message_id: updateId, date: 1, chat: chat(chatId), from, text,
      entities: text.startsWith("/") ? [{ type: "bot_command", offset: 0, length: text.split(" ")[0]!.length }] : [],
    } });
  };
  const text = () => calls.map((call) => call.payload.text ?? "").join("\n");
  const onlyThisChat = (chatId: number) => {
    for (const call of calls) {
      if (call.payload.chat_id !== undefined) assert.equal(call.payload.chat_id, chatId,
        `${call.method} must not touch another chat`);
    }
  };

  await click(group, `current:continue:${tournament.id}`);
  const groupMatchMessage = calls.find((call) => call.method === "sendMessage")!.messageId;
  await message(privateChat, "/start");
  onlyThisChat(privateChat);
  await click(privateChat, "menu:profile");
  onlyThisChat(privateChat);
  await click(privateChat, "menu:statistics");
  onlyThisChat(privateChat);
  await message(privateChat, "/stats A");
  assert.match(text(), /📊 A/);
  onlyThisChat(privateChat);
  await click(group, "menu:main");
  onlyThisChat(group);
  assert.ok(calls.some((call) => call.method === "deleteMessage" && call.payload.message_id === groupMatchMessage),
    "group match tracking must survive a visit to private chat");

  await click(group, "menu:new-tournament");
  for (const player of players) await click(group, `pick:${player.id}`);
  await click(privateChat, "menu:new-tournament");
  await click(privateChat, `pick:${players[0]!.id}`);
  await click(group, "setup:courts");
  assert.match(text(), /Сколько кортов доступно/);
  onlyThisChat(group);
  await click(privateChat, "setup:courts");
  assert.match(text(), /Выбери минимум четырёх игроков/);
  onlyThisChat(privateChat);

  await click(group, "player:add-other");
  await message(privateChat, "/start");
  onlyThisChat(privateChat);
  await message(privateChat, "Не добавлять игрока из лички");
  assert.equal((await service.listPlayers()).length, 4);
  await message(group, "Групповой игрок");
  assert.ok((await service.listPlayers()).some((player) => player.name === "Групповой игрок"));
  onlyThisChat(group);

  await message(group, "/egor");
  await message(privateChat, "/start");
  onlyThisChat(privateChat);
  await message(privateChat, "2");
  assert.equal(await service.egorMistakes(), 0);
  await message(group, "3");
  assert.equal(await service.egorMistakes(), 3);
  onlyThisChat(group);
});
