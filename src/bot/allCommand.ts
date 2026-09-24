import type { Bot } from "grammy";
import type { ChatMember, MessageEntity, User } from "grammy/types";
import type { ChatMemberRepository } from "../persistence/ChatMemberRepository";
import type { AllMentionsConfig } from "./allMentionUsernames";

const ALL_COOLDOWN_MS = 15 * 60 * 1000;

const isPresent = (member: ChatMember): boolean =>
  member.status !== "left" && member.status !== "kicked" &&
  (member.status !== "restricted" || member.is_member);

// Entity offsets and lengths use UTF-16, just like JavaScript string lengths.
export function formatAllMessages(
  users: User[], message: string, usernames: readonly string[] = [],
): { text: string; entities: MessageEntity[] }[] {
  const messages: { text: string; entities: MessageEntity[] }[] = [];
  let current: (typeof messages)[number] = { text: "", entities: [] };
  const flush = (): void => {
    if (current.text) messages.push(current);
    current = { text: "", entities: [] };
  };
  for (const character of message) {
    if (current.text.length + character.length > 4096) flush();
    current.text += character;
  }
  const mentions: { name: string; user?: User }[] = [];
  const seenUsernames = new Set<string>();
  const addUsername = (username: string): void => {
    const normalized = username.replace(/^@/, "");
    if (seenUsernames.has(normalized.toLowerCase())) return;
    seenUsernames.add(normalized.toLowerCase());
    mentions.push({ name: `@${normalized}` });
  };
  for (const username of usernames) addUsername(username);
  for (const user of users) {
    if (user.username) addUsername(user.username);
    else mentions.push({ name: [user.first_name, user.last_name].filter(Boolean).join(" "), user });
  }
  for (const { name, user } of mentions) {
    let separator = current.text ? (current.entities.length ? " " : "\n\n") : "";
    if (current.text.length + separator.length + name.length > 4096 || current.entities.length >= 50) {
      flush();
      separator = "";
    }
    current.text += separator;
    current.entities.push(user
      ? { type: "text_mention", offset: current.text.length, length: name.length, user }
      : { type: "mention", offset: current.text.length, length: name.length });
    current.text += name;
  }
  flush();
  return messages;
}

export function registerAllCommand(bot: Bot, members: ChatMemberRepository, config: AllMentionsConfig): void {
  // Observe updates before commands and conversational handlers consume them.
  bot.use(async (context, next) => {
    const chat = context.chat;
    if (chat?.type === "group" || chat?.type === "supergroup") {
      const message = context.message;
      if (message?.migrate_from_chat_id !== undefined) {
        for (const user of members.list(message.migrate_from_chat_id)) {
          members.save(chat.id, user);
          members.remove(message.migrate_from_chat_id, user.id);
        }
      }
      if (message?.migrate_to_chat_id !== undefined) {
        for (const user of members.list(chat.id)) {
          members.save(message.migrate_to_chat_id, user);
          members.remove(chat.id, user.id);
        }
        return next();
      }
      // chat_member.from is the administrator, not necessarily a member.
      if ((message && !message.sender_chat) || context.callbackQuery) {
        if (context.from) members.save(chat.id, context.from);
      }
      const replied = message?.reply_to_message;
      if (replied?.from && !replied.sender_chat) members.save(chat.id, replied.from);
      for (const user of message?.new_chat_members ?? []) members.save(chat.id, user);
      if (message?.left_chat_member) members.remove(chat.id, message.left_chat_member.id);
      const changed = context.chatMember?.new_chat_member;
      if (changed) {
        if (isPresent(changed)) members.save(chat.id, changed.user);
        else members.remove(chat.id, changed.user.id);
      }
    }
    await next();
  });

  bot.command("all", async (context) => {
    const command = context.message;
    const diagnostic = {
      updateId: context.update.update_id,
      chatId: context.chat.id,
      commandMessageId: command?.message_id,
    };
    config.log?.({
      ...diagnostic,
      event: "received",
      messageFields: Object.keys(command ?? {}),
      replyMessageId: command?.reply_to_message?.message_id ?? null,
      replyHasPoll: Boolean(command?.reply_to_message?.poll),
      externalReplyMessageId: command?.external_reply?.message_id ?? null,
      externalReplyChatId: command?.external_reply?.chat?.id ?? null,
      hasExternalReply: Boolean(command?.external_reply),
      hasQuote: Boolean(command?.quote),
      threadId: command?.message_thread_id ?? null,
    });
    if (context.chat.type !== "group" && context.chat.type !== "supergroup") {
      await context.reply("Команда /all работает только в беседе.");
      return;
    }
    const options = {
      ...(context.message?.reply_to_message ? {
        reply_parameters: { message_id: context.message.reply_to_message.message_id },
      } : {}),
      ...(context.message?.message_thread_id !== undefined ? {
        message_thread_id: context.message.message_thread_id,
      } : {}),
    };
    const claimedAt = (config.now ?? Date.now)();
    const remainingMs = members.acquireAllCooldown(context.chat.id, claimedAt, ALL_COOLDOWN_MS);
    if (remainingMs > 0) {
      const seconds = Math.ceil(remainingMs / 1000);
      config.log?.({ ...diagnostic, event: "rate_limited", remainingSeconds: seconds });
      await context.reply(`Пинговать всех можно раз в 15 минут. Подожди ещё ${Math.floor(seconds / 60)} мин. ${seconds % 60} сек.`, {
        ...(options.message_thread_id !== undefined ? { message_thread_id: options.message_thread_id } : {}),
        reply_parameters: { message_id: context.message!.message_id },
      });
      return;
    }
    let pingSent = false;
    try {
      const usernames = config.chatId === context.chat.id ? config.usernames : [];
      const present: User[] = [];
      let verificationFailed = false;
      try {
        for (const administrator of await context.getChatAdministrators()) {
          members.save(context.chat.id, administrator.user);
        }
      } catch {
        verificationFailed = true;
      }
      for (const user of members.list(context.chat.id)) {
        try {
          const member = await context.api.getChatMember(context.chat.id, user.id);
          if (isPresent(member) && !member.user.is_bot) {
            members.save(context.chat.id, member.user);
            present.push(member.user);
          } else {
            members.remove(context.chat.id, user.id);
          }
        } catch {
          verificationFailed = true;
        }
      }
      // The supplied usernames can be mentioned even without known Telegram IDs.
      if (verificationFailed && usernames.length === 0) {
        await context.reply("Не удалось проверить участников беседы. Убедитесь, что бот — администратор, и повторите /all.", options);
        return;
      }
      if (present.length === 0 && usernames.length === 0) {
        await context.reply("Пока не знаю участников беседы. Напишите сообщение в группе, чтобы попасть в список /all.", options);
        return;
      }
      for (const message of formatAllMessages(present, context.match, usernames)) {
        config.log?.({ ...diagnostic, event: "sending", replyParameters: options.reply_parameters ?? null });
        const sent = await context.reply(message.text, { ...options, entities: message.entities });
        if (message.entities.length > 0) pingSent = true;
        config.log?.({
          ...diagnostic,
          event: "sent",
          sentMessageId: sent.message_id,
          replyMessageId: sent.reply_to_message?.message_id ?? null,
          externalReplyMessageId: sent.external_reply?.message_id ?? null,
          externalReplyChatId: sent.external_reply?.chat?.id ?? null,
        });
      }
    } finally {
      // Failed attempts do not consume the interval; partial pings still do.
      if (!pingSent) members.releaseAllCooldown(context.chat.id, claimedAt);
    }
  });
}
