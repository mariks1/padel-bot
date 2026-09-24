import { createBot } from "./createBot";
import { TournamentService } from "../application/TournamentService";
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { SqliteTournamentRepository } from "../persistence/SqliteTournamentRepository";
import { SqliteChatMemberRepository } from "../persistence/SqliteChatMemberRepository";
import { allMentionUsernames } from "./allMentionUsernames";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("TELEGRAM_BOT_TOKEN is required");
const configuredChatId = process.env.ALL_MENTIONS_CHAT_ID?.trim();
const allMentionsChatId = configuredChatId ? Number(configuredChatId) : undefined;
if (allMentionsChatId !== undefined && (!Number.isSafeInteger(allMentionsChatId) || allMentionsChatId >= 0)) {
  throw new Error("ALL_MENTIONS_CHAT_ID must be a negative integer Telegram group ID");
}

const databasePath = resolve(process.env.PADEL_DATABASE_PATH ?? "data/padel.sqlite");
mkdirSync(dirname(databasePath), { recursive: true });
const database = new Database(databasePath);
const service = new TournamentService(new SqliteTournamentRepository(database));
console.log(`Starting Padel bot. Database: ${databasePath}`);
await createBot(token, service, new SqliteChatMemberRepository(database), {
  usernames: allMentionUsernames,
  chatId: allMentionsChatId,
  log: (event) => console.info(JSON.stringify({ scope: "all", timestamp: new Date().toISOString(), ...event })),
}).start({
  allowed_updates: ["message", "callback_query", "my_chat_member", "chat_member"],
  onStart: (info) => console.log(`Padel bot @${info.username} connected to Telegram and started polling.`),
});
