import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatMember, Message, Update, User } from "grammy/types";
import { createBot } from "../src/bot/createBot";
import { formatAllMessages } from "../src/bot/allCommand";
import { allMentionUsernames, type AllMentionsConfig } from "../src/bot/allMentionUsernames";
import { TournamentService } from "../src/application/TournamentService";
import { InMemoryTournamentRepository } from "../src/persistence/TournamentRepository";
import { InMemoryChatMemberRepository, type ChatMemberRepository } from "../src/persistence/ChatMemberRepository";
import { SqliteChatMemberRepository } from "../src/persistence/SqliteChatMemberRepository";

const user = (id: number, username?: string): User => ({
  id, is_bot: false, first_name: `Игрок ${id}`, ...(username ? { username } : {}),
});
const sender = user(1, "sender");
const group = { id: -100, type: "supergroup" as const, title: "Group" };

function harness(
  members: ChatMemberRepository = new InMemoryChatMemberRepository(),
  config: AllMentionsConfig = { usernames: [] },
) {
  const service = new TournamentService(new InMemoryTournamentRepository());
  // Existing scenario tests represent separate calls outside the cooldown.
  // Cooldown tests inject a manually controlled clock instead.
  let now = 1_700_000_000_000;
  const bot = createBot("123:test", service, members, {
    ...config, now: config.now ?? (() => { now += 15 * 60 * 1000; return now; }),
  });
  bot.botInfo = {
    id: 123, is_bot: true, first_name: "Test", username: "test_bot",
    can_join_groups: true, can_read_all_group_messages: true, supports_inline_queries: false,
    can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false,
    allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false,
  };
  const calls: { method: string; payload: Record<string, any> }[] = [];
  const statuses = new Map<number, ChatMember>();
  let administrators: User[] = [];
  let apiFails = false;
  let updateId = 0;
  bot.api.config.use(async (_previous, method, payload) => {
    const data = payload as Record<string, any>;
    calls.push({ method, payload: data });
    if (apiFails && (method === "getChatMember" || method === "getChatAdministrators")) {
      return { ok: false, error_code: 403, description: "Forbidden" };
    }
    const result: any = method === "getChatAdministrators"
      ? administrators.map((user) => ({ status: "creator", user, is_anonymous: false }))
      : method === "getChatMember"
      ? statuses.get(data.user_id) ?? {
        status: "member", user: members.list(data.chat_id).find((user) => user.id === data.user_id),
      }
      : method === "sendMessage"
      ? { message_id: 1000 + calls.length, date: 1, chat: group, text: data.text }
      : true;
    return { ok: true, result };
  });
  const update = async (body: Omit<Update, "update_id">) => {
    calls.length = 0;
    await bot.handleUpdate({ update_id: ++updateId, ...body } as Update);
  };
  const message = async (text: string, extra: Partial<Message.CommonMessage> = {}) => update({
    message: {
      message_id: updateId + 1, date: 1, chat: group, from: sender, text,
      entities: text.startsWith("/")
        ? [{ type: "bot_command", offset: 0, length: text.split(/\s/)[0]!.length }] : [],
      ...extra,
    } as NonNullable<Update["message"]>,
  });
  const sent = () => calls.filter((call) => call.method === "sendMessage").map((call) => call.payload);
  return { bot, service, members, calls, statuses, update, message, sent,
    administrators: (users: User[]) => { administrators = users; },
    fail: () => { apiFails = true; },
  };
}

test("/all mentions only this chat, refreshes usernames, includes admins and leaves ordinary messages alone", async () => {
  const h = harness();
  await h.message("Привет", { from: user(2, "old_name") });
  assert.equal(h.calls.length, 0, "ordinary group messages must not be deleted or answered");
  await h.message("Другая группа", { chat: { ...group, id: -200 }, from: user(3, "other_group") });
  await h.message("Личка", { chat: { id: 4, type: "private", first_name: "Private" }, from: user(4, "private") });
  h.members.save(group.id, user(5, "departed"));
  h.members.save(group.id, { ...user(6, "robot"), is_bot: true });
  h.statuses.set(2, { status: "member", user: user(2, "new_name") });
  h.statuses.set(5, { status: "left", user: user(5, "departed") });
  h.administrators([user(7, "admin")]);
  await h.message("/all");
  assert.equal(h.sent().length, 1);
  const result = h.sent()[0]!;
  assert.match(result.text, /@sender/);
  assert.match(result.text, /@new_name/);
  assert.match(result.text, /@admin/);
  assert.doesNotMatch(result.text, /old_name|other_group|private|departed|robot/);
  assert.equal(result.reply_parameters, undefined);
  assert.ok(!h.members.list(group.id).some((user) => user.id === 5));
  assert.ok(h.calls.every((call) => call.payload.chat_id === group.id));
});

test("/all supports text, replies, both together, targeted commands and forum topics", async () => {
  const h = harness();
  const reply: Message.TextMessage & { reply_to_message: undefined } = {
    message_id: 42, date: 1, chat: group, from: user(2, "author"), text: "Исходное сообщение", reply_to_message: undefined,
  };
  await h.message("/all Собираемся в 19:00");
  assert.equal(h.sent()[0]!.text, "Собираемся в 19:00\n\n@sender");
  assert.equal(h.sent()[0]!.reply_parameters, undefined);
  await h.message("/all", { reply_to_message: reply });
  assert.deepEqual(h.sent()[0]!.reply_parameters, { message_id: 42 });
  assert.match(h.sent()[0]!.text, /@author/);
  await h.message("/all@test_bot 🎾 <b>Встреча</b> & ещё\nВторая строка", {
    reply_to_message: reply, message_thread_id: 10, is_topic_message: true,
  });
  const result = h.sent()[0]!;
  assert.ok(result.text.startsWith("🎾 <b>Встреча</b> & ещё\nВторая строка\n\n"));
  assert.equal(result.parse_mode, undefined, "user text is literal, not injected markup");
  assert.deepEqual(result.reply_parameters, { message_id: 42 });
  assert.equal(result.message_thread_id, 10);
  for (const entity of result.entities) {
    assert.ok(["@sender", "@author"].includes(result.text.slice(entity.offset, entity.offset + entity.length)));
  }
});

test("/all mentions users without usernames by ID and keeps the user's pending dialog", async () => {
  const h = harness();
  const unnamed = { ...user(2), first_name: "🎾 Анна <&>", last_name: "Иванова" };
  await h.message("Фото", { from: unnamed });
  await h.update({ callback_query: {
    id: "click", data: "player:add-other", chat_instance: "group", from: sender,
    message: { message_id: 90, date: 1, chat: group, text: "menu" },
  } });
  await h.message("/all");
  const result = h.sent()[0]!;
  const mention = result.entities.find((entity: { type: string }) => entity.type === "text_mention");
  assert.equal(mention.user.id, 2);
  assert.equal(result.text.slice(mention.offset, mention.offset + mention.length), "🎾 Анна <&> Иванова");
  await h.message("Новый игрок");
  assert.equal((await h.service.listPlayers())[0]!.name, "Новый игрок");
});

test("/all with text in a reply includes all 26 supplied usernames once and newly discovered members", async () => {
  const h = harness(undefined, { usernames: allMentionUsernames, chatId: group.id });
  await h.message("Привет", { from: user(2, "KELIK2") });
  const reply: Message.TextMessage & { reply_to_message: undefined } = {
    message_id: 42, date: 1, chat: group, from: user(3, "new_member"),
    text: "Исходное сообщение", reply_to_message: undefined,
  };
  await h.message("/all 🎾 Собираемся в 19:00\nНе опаздывайте", { reply_to_message: reply });
  assert.equal(h.sent().length, 1);
  const result = h.sent()[0]!;
  assert.deepEqual(result.reply_parameters, { message_id: 42 });
  assert.ok(result.text.startsWith("🎾 Собираемся в 19:00\nНе опаздывайте\n\n"));
  const mentions = result.entities.map((entity: { offset: number; length: number }) =>
    result.text.slice(entity.offset, entity.offset + entity.length));
  assert.deepEqual(mentions, [...allMentionUsernames.map((username) => `@${username}`), "@sender", "@new_member"]);
  assert.equal(new Set(mentions.map((name: string) => name.toLowerCase())).size, 28);
  assert.equal(allMentionUsernames.length, 26);
});

test("supplied usernames still ping with reply text when Telegram cannot verify members", async () => {
  const h = harness(undefined, { usernames: allMentionUsernames, chatId: group.id });
  h.fail();
  await h.message("/all Встречаемся", {
    reply_to_message: {
      message_id: 42, date: 1, chat: group, from: sender, text: "План", reply_to_message: undefined,
    },
  });
  const result = h.sent()[0]!;
  assert.equal(h.sent().length, 1);
  assert.deepEqual(result.reply_parameters, { message_id: 42 });
  assert.equal(result.text, `Встречаемся\n\n${allMentionUsernames.map((username) => `@${username}`).join(" ")}`);
  assert.ok(!h.calls.some((call) => call.method === "deleteMessage"));
});

test("/all replying to a poll sends text and mentions with the poll's message ID", async () => {
  const events: Record<string, unknown>[] = [];
  const h = harness(undefined, { usernames: allMentionUsernames, chatId: group.id, log: (event) => events.push(event) });
  await h.message("/all голос в опрос надо", {
    reply_to_message: {
      message_id: 42, date: 1, chat: group, from: user(2), reply_to_message: undefined,
      poll: {
        id: "poll-1", question: "Когда играем?", options: [], total_voter_count: 0,
        is_closed: false, is_anonymous: true, type: "regular", allows_multiple_answers: false,
        allows_revoting: true, members_only: false,
      },
    },
  });
  assert.equal(h.sent().length, 1);
  assert.deepEqual(h.sent()[0]!.reply_parameters, { message_id: 42 });
  assert.ok(h.sent()[0]!.text.startsWith("голос в опрос надо\n\n@kelik2"));
  assert.equal(events[0]!.replyMessageId, 42);
  assert.equal(events[0]!.replyHasPoll, true);
  assert.deepEqual(events[1]!.replyParameters, { message_id: 42 });
  assert.doesNotMatch(JSON.stringify(events), /голос в опрос надо|Когда играем/);
});

test("configured manual list is limited to its chat and not included in private messages", async () => {
  const h = harness(undefined, { usernames: allMentionUsernames, chatId: group.id });
  await h.message("/all");
  assert.match(h.sent()[0]!.text, /@kelik2/);
  await h.message("/all", { chat: { ...group, id: -200 } });
  assert.equal(h.sent()[0]!.text, "@sender");
  await h.message("/all", { chat: { id: 1, type: "private", first_name: "Test" } });
  assert.match(h.sent()[0]!.text, /только в беседе/);
  assert.doesNotMatch(h.sent()[0]!.text, /@kelik2/);
});

test("supplied basic-group ID needs no supergroup prefix, and an unset ID never enables the manual list", async () => {
  const target = { id: -5504357996, type: "group" as const, title: "Padel" };
  const configured = harness(undefined, { usernames: allMentionUsernames, chatId: target.id });
  await configured.message("/all Собираемся", { chat: target });
  assert.equal(configured.sent()[0]!.chat_id, target.id);
  assert.match(configured.sent()[0]!.text, /@kelik2/);
  await configured.message("/all", { chat: { ...group, id: -1005504357996 } });
  assert.equal(configured.sent()[0]!.text, "@sender");
  const unconfigured = harness(undefined, { usernames: allMentionUsernames });
  await unconfigured.message("/all", { chat: target });
  assert.equal(unconfigured.sent()[0]!.text, "@sender");
});

test("membership events track their subject, remove leavers, and retain restricted members still in the chat", async () => {
  const h = harness();
  const changed = async (member: ChatMember) => h.update({ chat_member: {
    chat: group, from: user(99, "actor"), date: 1,
    old_chat_member: { status: "left", user: member.user }, new_chat_member: member,
  } });
  await h.update({ message: {
    message_id: 1, date: 1, chat: group, from: sender, new_chat_members: [user(2), user(3)],
  } });
  await changed({ status: "member", user: user(4) });
  await changed({ status: "left", user: user(2) });
  await changed({ status: "kicked", user: user(3), until_date: 0 });
  const restricted = {
    status: "restricted", user: user(5), is_member: true, until_date: 0,
    can_send_messages: false, can_send_audios: false, can_send_documents: false,
    can_send_photos: false, can_send_videos: false, can_send_video_notes: false,
    can_send_voice_notes: false, can_send_polls: false, can_send_other_messages: false,
    can_add_web_page_previews: false, can_change_info: false, can_invite_users: false,
    can_pin_messages: false, can_manage_topics: false, can_edit_tag: false, can_react_to_messages: false,
  } as const;
  await changed(restricted);
  await changed({ ...restricted, user: user(6), is_member: false });
  assert.deepEqual(h.members.list(group.id).map((user) => user.id).sort(), [1, 4, 5]);
  await h.update({ message: { message_id: 2, date: 1, chat: group, from: user(4), left_chat_member: user(4) } });
  assert.deepEqual(h.members.list(group.id).map((user) => user.id).sort(), [1, 5]);
});

test("private /all and failed membership checks return an explanation without stale pings", async () => {
  const h = harness();
  await h.message("/all", { chat: { id: 1, type: "private", first_name: "Test" } });
  assert.match(h.sent()[0]!.text, /только в беседе/);
  assert.ok(!h.calls.some((call) => call.method === "getChatMember"));
  h.fail();
  await h.message("/all");
  assert.match(h.sent()[0]!.text, /Не удалось проверить/);
  assert.equal(h.sent()[0]!.entities, undefined);
  assert.equal(h.members.list(group.id).length, 1, "API errors do not erase known members");
});

test("large pings split without losing text or mentions, with valid UTF-16 entity offsets", async () => {
  const users = Array.from({ length: 120 }, (_, i) => ({ ...user(i + 1), first_name: `🎾 ${"я".repeat(60)} ${i}` }));
  const prefix = "🎾".repeat(2046) + " текст";
  const messages = formatAllMessages(users, prefix);
  const mentioned: number[] = [];
  let copiedText = "";
  for (const message of messages) {
    assert.ok(message.text.length <= 4096);
    assert.ok(message.entities.length <= 50);
    assert.equal(Buffer.from(message.text, "utf8").toString("utf8"), message.text);
    if (message.entities.length === 0) copiedText += message.text;
    else if (mentioned.length === 0) copiedText += message.text.slice(0, message.entities[0]!.offset).replace(/\n\n$/, "");
    for (const entity of message.entities) {
      assert.equal(entity.type, "text_mention");
      if (entity.type !== "text_mention") continue;
      assert.equal(message.text.slice(entity.offset, entity.offset + entity.length), entity.user.first_name);
      mentioned.push(entity.user.id);
    }
  }
  assert.equal(copiedText, prefix);
  assert.deepEqual(mentioned, users.map((user) => user.id));
});

test("/all cooldown is shared by users in a chat, independent across chats, and expires at 15 minutes", async () => {
  let now = 1_700_000_000_000;
  const h = harness(undefined, { usernames: [], now: () => now });
  await h.message("/all");
  assert.equal(h.sent()[0]!.text, "@sender");
  await h.message("/all", { from: user(2, "another_user"), message_thread_id: 10 });
  assert.match(h.sent()[0]!.text, /ещё 15 мин\. 0 сек\./);
  assert.equal(h.sent()[0]!.entities, undefined);
  assert.equal(h.sent()[0]!.message_thread_id, 10);
  assert.ok(!h.calls.some((call) => call.method === "getChatMember"));
  await h.message("/all", { chat: { ...group, id: -200 } });
  assert.equal(h.sent()[0]!.text, "@sender");
  now += 899_999;
  await h.message("/all");
  assert.match(h.sent()[0]!.text, /ещё 0 мин\. 1 сек\./);
  now += 1;
  await h.message("/all");
  assert.ok(h.sent()[0]!.entities.length > 0, "rejected calls must not extend the interval");
});

test("simultaneous /all calls reserve the shared interval before Telegram requests finish", async () => {
  const events: Record<string, unknown>[] = [];
  const h = harness(undefined, { usernames: [], now: () => 1_700_000_000_000, log: (event) => events.push(event) });
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  h.bot.api.config.use(async (previous, method, payload, signal) => {
    if (method === "getChatAdministrators") {
      entered();
      await blocked;
    }
    return previous(method, payload, signal);
  });
  const first = h.message("/all");
  await started;
  try {
    await h.message("/all", { from: user(2, "another_user") });
    assert.match(h.sent()[0]!.text, /раз в 15 минут/);
  } finally {
    release();
    await first;
  }
  assert.equal(events.filter((event) => event.event === "sent").length, 1);
  assert.equal(events.filter((event) => event.event === "rate_limited").length, 1);
});

test("failed ping releases the interval so an immediate retry can succeed", async () => {
  const h = harness(undefined, { usernames: [], now: () => 1_700_000_000_000 });
  let failOnce = true;
  h.bot.api.config.use(async (previous, method, payload, signal) => {
    if (method === "sendMessage" && failOnce) {
      failOnce = false;
      return { ok: false, error_code: 400, description: "Bad Request: message to be replied not found" };
    }
    return previous(method, payload, signal);
  });
  await assert.rejects(h.message("/all"), /message to be replied not found/);
  await h.message("/all");
  assert.equal(h.sent()[0]!.text, "@sender");
  await h.message("/all");
  assert.match(h.sent()[0]!.text, /раз в 15 минут/);
});

test("SQLite members and /all cooldown survive a full restart and stay scoped to their chat", () => {
  const directory = mkdtempSync(join(tmpdir(), "padel-members-"));
  const path = join(directory, "test.sqlite");
  let database = new Database(path);
  try {
    let members = new SqliteChatMemberRepository(database);
    members.save(-100, user(1, "before"));
    members.save(-200, user(1, "other_chat"));
    members.save(-100, user(1));
    members.save(-100, user(2));
    members.remove(-100, 2);
    members.save(-100, { ...user(3), is_bot: true });
    assert.equal(members.acquireAllCooldown(-100, 1000, 900_000), 0);
    database.close();
    database = new Database(path);
    members = new SqliteChatMemberRepository(database);
    assert.deepEqual(members.list(-100), [user(1)]);
    assert.deepEqual(members.list(-200), [user(1, "other_chat")]);
    assert.deepEqual(members.list(-300), []);
    assert.equal(members.acquireAllCooldown(-100, 2000, 900_000), 899_000);
    assert.equal(members.acquireAllCooldown(-200, 2000, 900_000), 0);
    assert.equal(members.acquireAllCooldown(-100, 901_000, 900_000), 0);
    members.releaseAllCooldown(-100, 1000);
    assert.equal(members.acquireAllCooldown(-100, 901_000, 900_000), 900_000,
      "releasing an old reservation must not erase a newer ping");
    members.releaseAllCooldown(-100, 901_000);
    assert.equal(members.acquireAllCooldown(-100, 901_000, 900_000), 0);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
