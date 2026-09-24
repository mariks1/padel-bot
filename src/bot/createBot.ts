import { Bot, GrammyError, InlineKeyboard, type Context } from "grammy";
import { Agent } from "node:https";
import { TournamentService } from "../application/TournamentService";
import type { Match, Player, PlayerStatistics, Round, Tournament } from "../domain";
import { InMemoryChatMemberRepository, type ChatMemberRepository } from "../persistence/ChatMemberRepository";
import { registerAllCommand } from "./allCommand";
import { allMentionUsernames, type AllMentionsConfig } from "./allMentionUsernames";

type UserState =
  | { kind: "add-player" }
  | { kind: "select-players"; selectedIds: Set<string> }
  | { kind: "find-statistics"; candidateIds?: string[] }
  | { kind: "egor"; chatId: number; counterMessageId: number; promptMessageId: number };

const mainKeyboard = (): InlineKeyboard => new InlineKeyboard()
  .text("🏆 Создать турнир", "menu:new-tournament").row()
  .text("🏟 Текущий турнир", "menu:current").row()
  .text("👥 Игроки", "menu:players")
  .text("📚 История", "menu:history").row()
  .text("📊 Общая статистика", "menu:statistics").row()
  .text("🙋 Мой профиль", "menu:profile");

const homeKeyboard = (): InlineKeyboard => new InlineKeyboard()
  .text("🏠 Главное меню", "menu:main");

const egorKeyboard = (): InlineKeyboard => new InlineKeyboard()
  .text("🙈 Скрыть", "egor:hide");

export const createScoreKeyboard = (
  pointsToPlay: number,
  callbackData: (score: number) => string = (score) => `score-value:${score}`,
  footer: { text: string; callbackData: string } = {
    text: "🏠 Главное меню",
    callbackData: "menu:main",
  },
): InlineKeyboard => {
  const keyboard = new InlineKeyboard();
  for (let score = 0; score <= pointsToPlay; score += 1) {
    keyboard.text(`${score}:${pointsToPlay - score}`, callbackData(score));
    if ((score + 1) % 5 === 0 && score < pointsToPlay) keyboard.row();
  }
  return keyboard.row().text(footer.text, footer.callbackData);
};

const differenceText = (value: number): string => value >= 0 ? `+${value}` : String(value);

export const formatTournamentResults = (
  tournament: Tournament,
  mode: "final" | "current" = "final",
): string => {
  const standings = new Map(tournament.players.map((player) => [player.id, {
    player,
    games: 0,
    wins: 0,
    draws: 0,
    losses: 0,
    pointsFor: 0,
    pointsAgainst: 0,
  }]));

  const excludedGames = new Map<string, number>();
  const add = (
    players: readonly Player[], pointsFor: number, pointsAgainst: number,
    excludedIds: readonly string[] = [],
  ): void => {
    for (const player of players) {
      if (excludedIds.includes(player.id)) {
        excludedGames.set(player.id, (excludedGames.get(player.id) ?? 0) + 1);
        continue;
      }
      const row = standings.get(player.id)!;
      row.games += 1;
      row.pointsFor += pointsFor;
      row.pointsAgainst += pointsAgainst;
      if (pointsFor > pointsAgainst) row.wins += 1;
      else if (pointsFor === pointsAgainst) row.draws += 1;
      else row.losses += 1;
    }
  };

  const matches = tournament.rounds.flatMap((round) => round.matches);
  let scoredMatches = 0;
  for (const match of matches) {
    if (match.team1Score === undefined || match.team2Score === undefined) continue;
    scoredMatches += 1;
    add(match.team1, match.team1Score, match.team2Score, match.excludedFromStandingsPlayerIds);
    add(match.team2, match.team2Score, match.team1Score, match.excludedFromStandingsPlayerIds);
  }

  const rows = [...standings.values()].sort((left, right) =>
    right.pointsFor - left.pointsFor ||
    (right.pointsFor - right.pointsAgainst) - (left.pointsFor - left.pointsAgainst) ||
    right.wins - left.wins ||
    left.player.name.localeCompare(right.player.name, "ru")
  );

  return [
    tournament.cancelled ? "🚫 Турнир отменён" : mode === "final" ? "🏁 Турнир завершён!" : "🏟 Текущий турнир",
    `🏆 ${tournament.name}`,
    ...(mode === "current" || tournament.cancelled ? [`Сыграно матчей: ${scoredMatches} из ${matches.length}`] : []),
    ...(tournament.cancelled ? ["Результаты исключены из общей и личной статистики."] : []),
    "",
    tournament.cancelled ? "Результаты до отмены:" : mode === "final" ? "Итоговая таблица:" : "Текущая таблица:",
    ...rows.map((row, index) => {
      const difference = row.pointsFor - row.pointsAgainst;
      return `${index + 1}. ${row.player.name} — ${row.pointsFor} очк. ` +
        `(${differenceText(difference)}), ${row.wins}-${row.draws}-${row.losses}`;
    }),
    "",
    "Формат: очки (разница), победы-ничьи-поражения.",
    ...(excludedGames.size > 0 ? [
      "",
      ...[...excludedGames].map(([playerId, count]) =>
        `Корректировка зачёта: ${standings.get(playerId)!.player.name} — исключено матчей: ${count}.`),
      "Эти матчи сохранены в истории и учитываются в общей и личной статистике, если турнир не отменён.",
    ] : []),
  ].join("\n");
};

const displayName = (context: Context): string => {
  const firstName = context.from?.first_name ?? "Игрок";
  return context.from?.last_name ? `${firstName} ${context.from.last_name}` : firstName;
};

export const formatStatistics = (statistics: PlayerStatistics): string => [
  `📊 ${statistics.player.name}`,
  `Турниры: ${statistics.tournamentsPlayed}`,
  `Матчи: ${statistics.gamesPlayed}`,
  `Победы / ничьи / поражения: ${statistics.wins} / ${statistics.draws} / ${statistics.losses}`,
  `Очки: ${statistics.pointsFor}:${statistics.pointsAgainst} (${differenceText(statistics.pointsDifference)})`,
  `Средний счёт: ${statistics.averagePointsFor.toFixed(1)}:${statistics.averagePointsAgainst.toFixed(1)}`,
  `Винрейт: ${statistics.winRate.toFixed(1)}% (ничья = ½ победы)`,
  `Уникальные партнёры: ${statistics.uniquePartners}`,
  `Уникальные соперники: ${statistics.uniqueOpponents}`,
  "",
  ...(statistics.bestPartnerByWinRate ? [
    `🤝 Чаще всего побеждаешь с: ${statistics.bestPartnerByWinRate.player.name}`,
    `Винрейт вместе: ${statistics.bestPartnerByWinRate.winRate.toFixed(1)}% ` +
      `(побед: ${statistics.bestPartnerByWinRate.wins}, ничьих: ${statistics.bestPartnerByWinRate.draws}, ` +
      `матчей: ${statistics.bestPartnerByWinRate.gamesPlayed})`,
  ] : ["🤝 Лучший партнёр по винрейту: пока нет сыгранных матчей."]),
  ...(statistics.bestPartnerByAveragePoints ? [
    `🎯 Больше всего очков в среднем с: ${statistics.bestPartnerByAveragePoints.player.name}`,
    `${statistics.bestPartnerByAveragePoints.averagePointsFor.toFixed(1)} очк. за матч ` +
      `(совместных матчей: ${statistics.bestPartnerByAveragePoints.gamesPlayed})`,
  ] : ["🎯 Лучший партнёр по средним очкам: пока нет сыгранных матчей."]),
].join("\n");

const formatMatch = (
  tournament: Tournament,
  round: Round,
  match: Match,
  includeResting: boolean,
): string => {
  const lines = [
    `🏆 ${tournament.name}`,
    `Раунд ${round.number} из ${tournament.rounds.length} · Корт ${match.court}`,
    "",
    `Команда 1: ${match.team1.map((player) => player.name).join(" + ")}`,
    `Команда 2: ${match.team2.map((player) => player.name).join(" + ")}`,
    "",
    "Выбери итоговый счёт:",
  ];
  if (includeResting && round.restingPlayers.length > 0) {
    lines.push("", `Отдыхают: ${round.restingPlayers.map((player) => player.name).join(", ")}`);
  }
  return lines.join("\n");
};

export function createBot(
  token: string,
  service: TournamentService,
  members: ChatMemberRepository = new InMemoryChatMemberRepository(),
  allMentions: AllMentionsConfig = { usernames: allMentionUsernames },
): Bot {
  const bot = new Bot(token, {
    client: {
      baseFetchConfig: {
        agent: new Agent({ keepAlive: true, proxyEnv: process.env }),
      },
    },
  });
  registerAllCommand(bot, members, allMentions);
  const states = new Map<string, UserState>();
  const menuMessages = new Map<string, { chatId: number; messageId: number }>();
  const matchMessages = new Map<string, { chatId: number; messageIds: Set<number> }>();
  const tournamentQueues = new Map<string, Promise<void>>();

  // Menus, pending input and match messages belong to this user's chat session.
  // Tournament data and score serialization remain shared across chats.
  const sessionKey = (context: Context): string => {
    if (!context.chat || !context.from) throw new Error("Chat and user are required for interactive state");
    return `${context.chat.id}:${context.from.id}`;
  };

  const safeDelete = async (context: Context, chatId: number, messageId: number): Promise<void> => {
    if (chatId !== context.chat?.id) return;
    try {
      await context.api.deleteMessage(chatId, messageId);
    } catch {
      // It is fine if Telegram has already removed the message.
    }
  };

  const clearEgorMessages = async (context: Context): Promise<boolean> => {
    const userId = context.from?.id;
    if (userId === undefined) return false;
    const state = states.get(sessionKey(context));
    if (state?.kind !== "egor") return false;
    states.delete(sessionKey(context));
    await Promise.all([
      safeDelete(context, state.chatId, state.counterMessageId),
      safeDelete(context, state.chatId, state.promptMessageId),
    ]);
    return true;
  };

  const clearMenu = async (context: Context): Promise<void> => {
    const userId = context.from?.id;
    if (userId === undefined) return;
    const message = menuMessages.get(sessionKey(context));
    menuMessages.delete(sessionKey(context));
    if (message) await safeDelete(context, message.chatId, message.messageId);
  };

  const clearMatches = async (context: Context): Promise<boolean> => {
    const userId = context.from?.id;
    if (userId === undefined) return false;
    const messages = matchMessages.get(sessionKey(context));
    matchMessages.delete(sessionKey(context));
    if (!messages) return false;
    await Promise.all([...messages.messageIds].map((messageId) =>
      safeDelete(context, messages.chatId, messageId)
    ));
    return messages.messageIds.size > 0;
  };

  const deleteCurrent = async (context: Context): Promise<void> => {
    const userId = context.from?.id;
    const chatId = context.chat?.id;
    const messageId = context.callbackQuery?.message?.message_id ?? context.message?.message_id;
    if (chatId === undefined || messageId === undefined) return;
    if (userId !== undefined) matchMessages.get(sessionKey(context))?.messageIds.delete(messageId);
    await safeDelete(context, chatId, messageId);
  };

  const render = async (
    context: Context,
    text: string,
    keyboard: InlineKeyboard,
    editCurrent = true,
  ): Promise<void> => {
    const userId = context.from?.id;
    const current = context.callbackQuery?.message;
    if (editCurrent && current && userId !== undefined) {
      try {
        const previous = menuMessages.get(sessionKey(context));
        if (previous && previous.messageId !== current.message_id) {
          await safeDelete(context, previous.chatId, previous.messageId);
        }
        await context.editMessageText(text, { reply_markup: keyboard });
        menuMessages.set(sessionKey(context), { chatId: current.chat.id, messageId: current.message_id });
        return;
      } catch {
        await safeDelete(context, current.chat.id, current.message_id);
      }
    }
    await clearMenu(context);
    const message = await context.reply(text, { reply_markup: keyboard });
    if (userId !== undefined) {
      menuMessages.set(sessionKey(context), { chatId: message.chat.id, messageId: message.message_id });
    }
  };

  const recognize = async (context: Context): Promise<Player | undefined> => {
    if (!context.from) return undefined;
    return service.recognizePlayer(context.from.id, context.from.username);
  };

  const showMain = async (context: Context, notice?: string, editCurrent = true): Promise<void> => {
    const player = await recognize(context);
    const greeting = player
      ? `Привет, ${player.name}! Я узнал тебя по Telegram.`
      : "Привет! Создай свой профиль или выбери сохранённых игроков для турнира.";
    await render(context, notice ? `${notice}\n\n${greeting}` : greeting, mainKeyboard(), editCurrent);
  };

  const statisticsBackKeyboard = (): InlineKeyboard => new InlineKeyboard()
    .text("⬅️ Общая статистика", "menu:statistics").row()
    .text("🏠 Главное меню", "menu:main");

  const showPlayerStatistics = async (context: Context, player: Player): Promise<void> => {
    states.delete(sessionKey(context));
    await render(context, formatStatistics(await service.statisticsFor(player)), new InlineKeyboard()
      .text("🔎 Другой игрок", "statistics:search").row()
      .text("⬅️ Общая статистика", "menu:statistics").row()
      .text("🏠 Главное меню", "menu:main"));
  };

  const showStatisticsSearch = async (context: Context): Promise<void> => {
    states.set(sessionKey(context), { kind: "find-statistics" });
    await render(context, "Введи имя игрока или @username. Можно часть имени.\n\nНапример: /stats Егор", statisticsBackKeyboard());
  };

  const searchStatistics = async (context: Context, query: string): Promise<void> => {
    const players = await service.listPlayers();
    const state = states.get(sessionKey(context));
    const value = query.trim();
    if (state?.kind === "find-statistics" && state.candidateIds && /^\d+$/.test(value)) {
      const playerId = state.candidateIds[Number(value) - 1];
      const selected = players.find((player) => player.id === playerId);
      if (selected) await showPlayerStatistics(context, selected);
      else await render(context, `Введи номер от 1 до ${state.candidateIds.length} или уточни имя.`, statisticsBackKeyboard());
      return;
    }
    if (!value) {
      await showStatisticsSearch(context);
      return;
    }
    const normalize = (text: string): string => text.toLocaleLowerCase("ru-RU").replaceAll("ё", "е");
    const needle = normalize(value);
    const username = needle.replace(/^@/, "");
    const exact = players.filter((player) =>
      normalize(player.name) === needle || player.telegramUsername?.toLowerCase() === username);
    const matches = exact.length > 0 ? exact : players.filter((player) =>
      needle.startsWith("@")
        ? player.telegramUsername?.toLowerCase().includes(username)
        : normalize(player.name).includes(needle));
    if (matches.length === 1) {
      await showPlayerStatistics(context, matches[0]!);
      return;
    }
    states.set(sessionKey(context), {
      kind: "find-statistics",
      ...(matches.length > 0 && matches.length <= 10 ? { candidateIds: matches.map((player) => player.id) } : {}),
    });
    const text = matches.length === 0
      ? "Игрок не найден. Попробуй другое имя или @username."
      : matches.length > 10
      ? "Нашлось больше 10 игроков. Уточни имя или введи @username."
      : "Нашлось несколько игроков. Введи номер или уточни имя:\n\n" +
        matches.map((player, index) => `${index + 1}. ${player.name}${player.telegramUsername ? ` (@${player.telegramUsername})` : ""}`).join("\n");
    await render(context, text, statisticsBackKeyboard());
  };

  const showPlayers = async (context: Context): Promise<void> => {
    const players = await service.listPlayers();
    const list = players.length === 0
      ? "Пока нет сохранённых игроков."
      : players.map((player, index) =>
        `${index + 1}. ${player.name}${player.telegramUsername ? ` (@${player.telegramUsername})` : ""}`
      ).join("\n");
    const keyboard = new InlineKeyboard()
      .text("➕ Добавить себя", "player:add-self")
      .text("➕ Добавить игрока", "player:add-other").row();
    keyboard.text("🏠 Главное меню", "menu:main");
    await render(context, `👥 Игроки\n\n${list}`, keyboard);
  };

  const showPlayerSelection = async (
    context: Context,
    state: Extract<UserState, { kind: "select-players" }>,
  ): Promise<void> => {
    const players = await service.listPlayers();
    const keyboard = new InlineKeyboard();
    for (const player of players) {
      keyboard.text(`${state.selectedIds.has(player.id) ? "✅" : "▫️"} ${player.name}`, `pick:${player.id}`).row();
    }
    keyboard.text(`Продолжить (${state.selectedIds.size})`, "setup:courts").row()
      .text("🏠 Главное меню", "menu:main");
    await render(context, "Выбери минимум четырёх игроков:", keyboard);
  };

  const showHistoryTournament = async (
    context: Context,
    requestedTournamentId?: string,
  ): Promise<void> => {
    const tournaments = await service.listTournaments();
    if (tournaments.length === 0) {
      await render(context, "📚 История турниров пока пуста.", homeKeyboard());
      return;
    }
    const requestedIndex = requestedTournamentId
      ? tournaments.findIndex((tournament) => tournament.id === requestedTournamentId)
      : 0;
    const index = requestedIndex >= 0 ? requestedIndex : 0;
    const tournament = tournaments[index]!;
    const matches = tournament.rounds.flatMap((round) => round.matches);
    const scored = matches.filter((match) =>
      match.team1Score !== undefined && match.team2Score !== undefined
    ).length;
    const completed = scored === matches.length;
    const keyboard = new InlineKeyboard()
      .text("◀️", index > 0 ? `history:tournament:${tournaments[index - 1]!.id}` : "history:noop")
      .text(`${index + 1} / ${tournaments.length}`, "history:noop")
      .text("▶️", index + 1 < tournaments.length
        ? `history:tournament:${tournaments[index + 1]!.id}`
        : "history:noop").row()
      .text("🎾 Матчи", `history:games:${tournament.id}:1`);
    if (!tournament.cancelled) {
      keyboard.row().text("🚫 Отменить турнир", `cancel:ask:${tournament.id}`);
    }
    keyboard.row().text("🏠 Главное меню", "menu:main");
    await render(
      context,
      `📚 История турниров\n\n${formatTournamentResults(tournament, completed ? "final" : "current")}`,
      keyboard,
    );
  };

  const showHistoryRound = async (
    context: Context,
    tournament: Tournament,
    requestedRoundNumber: number,
  ): Promise<void> => {
    const index = Math.max(0, tournament.rounds.findIndex((round) => round.number === requestedRoundNumber));
    const round = tournament.rounds[index];
    if (!round) {
      await showHistoryTournament(context, tournament.id);
      return;
    }
    const lines = [
      `🎾 ${tournament.name}`,
      `Раунд ${round.number} из ${tournament.rounds.length}`,
      "",
    ];
    const keyboard = new InlineKeyboard();
    for (const match of round.matches) {
      const score = match.team1Score === undefined || match.team2Score === undefined
        ? "не сыгран"
        : `${match.team1Score}:${match.team2Score}`;
      lines.push(
        `Корт ${match.court}: ${match.team1.map((player) => player.name).join(" + ")}`,
        `против ${match.team2.map((player) => player.name).join(" + ")} — ${score}`,
        "",
      );
      const excludedNames = [...match.team1, ...match.team2]
        .filter((player) => match.excludedFromStandingsPlayerIds?.includes(player.id))
        .map((player) => player.name);
      if (excludedNames.length > 0) {
        lines.push(`Не учитывается в зачёте турнира для: ${excludedNames.join(", ")}.`, "");
      }
      if (!tournament.cancelled) {
        keyboard.text(
          `✏️ Корт ${match.court} · ${score}`,
          `history:edit:${tournament.id}:${match.id}`,
        ).row();
      }
    }
    if (round.restingPlayers.length > 0) {
      lines.push(`Отдыхали: ${round.restingPlayers.map((player) => player.name).join(", ")}`);
    }
    if (tournament.cancelled) lines.push("", "🚫 Турнир отменён. Результаты исключены из статистики.");
    keyboard
      .text("◀️", index > 0 ? `history:games:${tournament.id}:${tournament.rounds[index - 1]!.number}` : "history:noop")
      .text(`${index + 1} / ${tournament.rounds.length}`, "history:noop")
      .text("▶️", index + 1 < tournament.rounds.length
        ? `history:games:${tournament.id}:${tournament.rounds[index + 1]!.number}`
        : "history:noop").row()
      .text("⬅️ К турниру", `history:tournament:${tournament.id}`).row()
      .text("🏠 Главное меню", "menu:main");
    await render(context, lines.join("\n").trim(), keyboard);
  };

  const showCurrentTournament = async (context: Context): Promise<void> => {
    const tournaments = await service.listTournaments();
    const tournament = tournaments.find((candidate) =>
      !candidate.cancelled && candidate.rounds.some((round) =>
        round.matches.some((match) => match.team1Score === undefined || match.team2Score === undefined)
      )
    );
    if (!tournament) {
      await render(context, "Сейчас нет незавершённого турнира.", new InlineKeyboard()
        .text("📚 История турниров", "menu:history").row()
        .text("🏠 Главное меню", "menu:main"));
      return;
    }
    const firstIncompleteRound = tournament.rounds.find((round) =>
      round.matches.some((match) => match.team1Score === undefined || match.team2Score === undefined)
    )!;
    await render(context, formatTournamentResults(tournament, "current"), new InlineKeyboard()
      .text("▶️ Продолжить турнир", `current:continue:${tournament.id}`).row()
      .text("🎾 История игр", `history:games:${tournament.id}:${firstIncompleteRound.number}`).row()
      .text("🚫 Отменить турнир", `cancel:ask:${tournament.id}`).row()
      .text("📚 Все турниры", `history:tournament:${tournament.id}`).row()
      .text("🏠 Главное меню", "menu:main"));
  };

  const showResults = async (context: Context, tournament: Tournament): Promise<void> => {
    await clearMatches(context);
    await render(context, formatTournamentResults(tournament), new InlineKeyboard()
      .text("🎾 История матчей", `history:games:${tournament.id}:1`).row()
      .text("📚 Все турниры", `history:tournament:${tournament.id}`).row()
      .text("🏠 Главное меню", "menu:main"), false);
  };

  const showRound = async (context: Context, tournament: Tournament, round: Round): Promise<void> => {
    await clearMatches(context);
    await clearMenu(context);
    const unscored = round.matches.filter((match) =>
      match.team1Score === undefined || match.team2Score === undefined
    );
    if (unscored.length === 0) {
      const next = tournament.rounds.find((candidate) =>
        candidate.matches.some((match) => match.team1Score === undefined || match.team2Score === undefined)
      );
      if (next) await showRound(context, tournament, next);
      else await showResults(context, tournament);
      return;
    }

    for (const [index, match] of unscored.entries()) {
      const keyboard = createScoreKeyboard(
        match.pointsToPlay,
        (score) => `result:${tournament.id}:${match.id}:${score}`,
      );
      const message = await context.reply(formatMatch(tournament, round, match, index === 0), {
        reply_markup: keyboard,
      });
      if (context.from) {
        const tracked = matchMessages.get(sessionKey(context)) ?? {
          chatId: message.chat.id,
          messageIds: new Set<number>(),
        };
        tracked.messageIds.add(message.message_id);
        matchMessages.set(sessionKey(context), tracked);
      }
    }
  };

  const continueTournament = async (context: Context, tournament: Tournament): Promise<void> => {
    if (tournament.cancelled) {
      await clearMatches(context);
      await showHistoryTournament(context, tournament.id);
      return;
    }
    const next = tournament.rounds.find((round) =>
      round.matches.some((match) => match.team1Score === undefined || match.team2Score === undefined)
    );
    if (next) await showRound(context, tournament, next);
    else await showResults(context, tournament);
  };

  const serialized = async <T>(tournamentId: string, action: () => Promise<T>): Promise<T> => {
    const previous = tournamentQueues.get(tournamentId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(action);
    const settled = result.then(() => undefined, () => undefined);
    tournamentQueues.set(tournamentId, settled);
    try {
      return await result;
    } finally {
      if (tournamentQueues.get(tournamentId) === settled) tournamentQueues.delete(tournamentId);
    }
  };

  const start = async (context: Context): Promise<void> => {
    await clearEgorMessages(context);
    if (context.from) states.delete(sessionKey(context));
    await clearMatches(context);
    await deleteCurrent(context);
    await showMain(context, undefined, false);
  };

  bot.command("start", start);
  bot.command("menu", start);

  bot.command("stats", async (context) => {
    await clearEgorMessages(context);
    states.delete(sessionKey(context));
    await deleteCurrent(context);
    await searchStatistics(context, context.match);
  });

  bot.command("name", async (context) => {
    const userId = context.from?.id;
    if (userId === undefined) return;
    const newName = context.match.trim();
    await clearEgorMessages(context);
    states.delete(sessionKey(context));
    const player = await recognize(context);
    await deleteCurrent(context);
    if (!newName) {
      await showMain(context, "Использование: /name Новое имя", false);
      return;
    }
    if (!player) {
      await showMain(context, "Сначала создай и привяжи свой профиль.", false);
      return;
    }
    try {
      const renamed = await service.renamePlayer(player.id, newName);
      await showMain(context, `Теперь твоё имя: ${renamed.name} ✅`, false);
    } catch (error) {
      await showMain(
        context,
        error instanceof Error ? error.message : "Не удалось изменить имя",
        false,
      );
    }
  });

  bot.command("egor", async (context) => {
    const userId = context.from?.id;
    if (userId === undefined) return;
    await clearEgorMessages(context);
    states.delete(sessionKey(context));
    await deleteCurrent(context);
    const count = await service.egorMistakes();
    const counterMessage = await context.reply(`Ошибок Егора: ${count}`, {
      reply_markup: egorKeyboard(),
    });
    const promptMessage = await context.reply("Сколько ошибок сделал егор за игру?", {
      reply_markup: egorKeyboard(),
    });
    states.set(sessionKey(context), {
      kind: "egor",
      chatId: context.chat.id,
      counterMessageId: counterMessage.message_id,
      promptMessageId: promptMessage.message_id,
    });
  });

  bot.callbackQuery("menu:main", async (context) => {
    states.delete(sessionKey(context));
    await context.answerCallbackQuery();
    const deleted = await clearMatches(context);
    await showMain(context, undefined, !deleted);
  });

  bot.callbackQuery("menu:players", async (context) => {
    await context.answerCallbackQuery();
    await showPlayers(context);
  });

  bot.callbackQuery("menu:current", async (context) => {
    await context.answerCallbackQuery();
    await showCurrentTournament(context);
  });

  bot.callbackQuery(/^current:continue:([^:]+)$/, async (context) => {
    await context.answerCallbackQuery();
    const tournament = await service.findById(context.match[1]!);
    if (!tournament) {
      await showMain(context, "Турнир не найден.");
      return;
    }
    await deleteCurrent(context);
    await clearMenu(context);
    await continueTournament(context, tournament);
  });

  bot.callbackQuery(/^cancel:ask:([^:]+)$/, async (context) => {
    await context.answerCallbackQuery();
    const tournament = await service.findById(context.match[1]!);
    if (!tournament) {
      await showMain(context, "Турнир не найден.");
      return;
    }
    if (tournament.cancelled) {
      await showHistoryTournament(context, tournament.id);
      return;
    }
    await render(context,
      `Отменить турнир «${tournament.name}»?\n\n` +
      "Он останется в истории, но все его результаты будут исключены из статистики. Продолжить отменённый турнир нельзя.",
      new InlineKeyboard()
        .text("Да, отменить турнир", `cancel:confirm:${tournament.id}`).row()
        .text("⬅️ Назад", `history:tournament:${tournament.id}`));
  });

  bot.callbackQuery(/^cancel:confirm:([^:]+)$/, async (context) => {
    const tournamentId = context.match[1]!;
    await serialized(tournamentId, async () => {
      const tournament = await service.findById(tournamentId);
      if (!tournament) {
        await context.answerCallbackQuery({ text: "Турнир не найден", show_alert: true });
        return;
      }
      await service.cancel(tournamentId);
      await context.answerCallbackQuery({ text: "Турнир отменён" });
      await clearMatches(context);
      await showHistoryTournament(context, tournamentId);
    });
  });

  bot.callbackQuery("egor:hide", async (context) => {
    await context.answerCallbackQuery();
    const deleted = await clearEgorMessages(context);
    if (!deleted) await deleteCurrent(context);
  });

  bot.callbackQuery("menu:history", async (context) => {
    await context.answerCallbackQuery();
    await showHistoryTournament(context);
  });

  bot.callbackQuery("history:noop", async (context) => {
    await context.answerCallbackQuery();
  });

  bot.callbackQuery(/^history:tournament:([^:]+)$/, async (context) => {
    await context.answerCallbackQuery();
    await showHistoryTournament(context, context.match[1]);
  });

  bot.callbackQuery(/^history:games:([^:]+):(\d+)$/, async (context) => {
    await context.answerCallbackQuery();
    const tournament = await service.findById(context.match[1]!);
    if (!tournament) {
      await showMain(context, "Турнир не найден.");
      return;
    }
    await showHistoryRound(context, tournament, Number(context.match[2]));
  });

  bot.callbackQuery(/^history:results:([^:]+)$/, async (context) => {
    await context.answerCallbackQuery();
    const tournament = await service.findById(context.match[1]!);
    if (!tournament) {
      await showMain(context, "Турнир не найден.");
      return;
    }
    await render(context, formatTournamentResults(tournament), new InlineKeyboard()
      .text("🎾 Матчи", `history:games:${tournament.id}:1`).row()
      .text("⬅️ К турниру", `history:tournament:${tournament.id}`).row()
      .text("🏠 Главное меню", "menu:main"));
  });

  bot.callbackQuery(/^history:edit:([^:]+):([^:]+)$/, async (context) => {
    await context.answerCallbackQuery();
    const tournament = await service.findById(context.match[1]!);
    const round = tournament?.rounds.find((item) =>
      item.matches.some((match) => match.id === context.match[2])
    );
    const match = round?.matches.find((item) => item.id === context.match[2]);
    if (!tournament || !round || !match) {
      await showMain(context, "Матч не найден.");
      return;
    }
    if (tournament.cancelled) {
      await showHistoryRound(context, tournament, round.number);
      return;
    }
    const previousScore = match.team1Score === undefined || match.team2Score === undefined
      ? "не введён"
      : `${match.team1Score}:${match.team2Score}`;
    await render(context, [
      `✏️ Исправление счёта · Раунд ${round.number} · Корт ${match.court}`,
      "",
      `Команда 1: ${match.team1.map((player) => player.name).join(" + ")}`,
      `Команда 2: ${match.team2.map((player) => player.name).join(" + ")}`,
      `Текущий счёт: ${previousScore}`,
      "",
      "Выбери новый счёт:",
    ].join("\n"), createScoreKeyboard(
      match.pointsToPlay,
      (score) => `history:set:${tournament.id}:${match.id}:${score}`,
      { text: "⬅️ Без изменений", callbackData: `history:games:${tournament.id}:${round.number}` },
    ));
  });

  bot.callbackQuery(/^history:set:([^:]+):([^:]+):(\d+)$/, async (context) => {
    const tournamentId = context.match[1]!;
    const matchId = context.match[2]!;
    const score = Number(context.match[3]);
    await serialized(tournamentId, async () => {
      const tournament = await service.findById(tournamentId);
      const round = tournament?.rounds.find((item) =>
        item.matches.some((match) => match.id === matchId)
      );
      const match = round?.matches.find((item) => item.id === matchId);
      if (!tournament || !round || !match || score > match.pointsToPlay) {
        await context.answerCallbackQuery({ text: "Матч или счёт некорректен", show_alert: true });
        return;
      }
      if (tournament.cancelled) {
        await context.answerCallbackQuery({ text: "Турнир отменён", show_alert: true });
        await showHistoryRound(context, tournament, round.number);
        return;
      }
      const opponentScore = match.pointsToPlay - score;
      const updated = await service.recordScore(tournamentId, matchId, score, opponentScore);
      await context.answerCallbackQuery({ text: `Счёт изменён на ${score}:${opponentScore}` });
      await showHistoryRound(context, updated, round.number);
    });
  });

  bot.callbackQuery("player:add-self", async (context) => {
    await context.answerCallbackQuery();
    try {
      const existing = await recognize(context);
      if (existing) {
        await showMain(context, `Ты уже зарегистрирован как ${existing.name}.`);
        return;
      }
      const player = await service.createPlayer(displayName(context), {
        userId: context.from.id,
        username: context.from.username,
      });
      await showMain(context, `Профиль ${player.name} создан и привязан к Telegram ✅`);
    } catch (error) {
      await render(context, error instanceof Error ? error.message : "Не удалось создать игрока", homeKeyboard());
    }
  });

  bot.callbackQuery("player:add-other", async (context) => {
    states.set(sessionKey(context), { kind: "add-player" });
    await context.answerCallbackQuery();
    await render(context, "Отправь имя игрока. Можно сразу добавить username:\nИван Иванов @ivan", homeKeyboard());
  });

  bot.callbackQuery(/^player:rename:/, async (context) => {
    await context.answerCallbackQuery({
      text: "Теперь имя меняется командой /name Новое имя",
      show_alert: true,
    });
  });

  bot.callbackQuery("menu:new-tournament", async (context) => {
    await context.answerCallbackQuery();
    const players = await service.listPlayers();
    if (players.length < 4) {
      await render(context, "Для турнира нужно сохранить минимум четырёх игроков.", new InlineKeyboard()
        .text("👥 Добавить игроков", "menu:players").row()
        .text("🏠 Главное меню", "menu:main"));
      return;
    }
    const state: Extract<UserState, { kind: "select-players" }> = {
      kind: "select-players",
      selectedIds: new Set(),
    };
    states.set(sessionKey(context), state);
    await showPlayerSelection(context, state);
  });

  bot.callbackQuery(/^pick:(.+)$/, async (context) => {
    await context.answerCallbackQuery();
    const state = states.get(sessionKey(context));
    if (state?.kind !== "select-players") {
      await showMain(context, "Выбор игроков устарел. Начни создание турнира заново.");
      return;
    }
    const id = context.match[1]!;
    if (state.selectedIds.has(id)) state.selectedIds.delete(id);
    else state.selectedIds.add(id);
    await showPlayerSelection(context, state);
  });

  bot.callbackQuery("setup:courts", async (context) => {
    const state = states.get(sessionKey(context));
    if (state?.kind !== "select-players" || state.selectedIds.size < 4) {
      await context.answerCallbackQuery({ text: "Выбери минимум четырёх игроков", show_alert: true });
      return;
    }
    await context.answerCallbackQuery();
    await render(context, "Сколько кортов доступно?", new InlineKeyboard()
      .text("1", "court:1").text("2", "court:2").text("3", "court:3").text("4", "court:4").row()
      .text("🏠 Главное меню", "menu:main"));
  });

  bot.callbackQuery(/^court:([1-4])$/, async (context) => {
    if (states.get(sessionKey(context))?.kind !== "select-players") {
      await context.answerCallbackQuery({ text: "Создание турнира уже завершено", show_alert: true });
      return;
    }
    await context.answerCallbackQuery();
    const courts = Number(context.match[1]);
    await render(context, "Сколько очков разыгрывается в матче?", new InlineKeyboard()
      .text("16", `create:${courts}:16`).text("24", `create:${courts}:24`).text("32", `create:${courts}:32`).row()
      .text("🏠 Главное меню", "menu:main"));
  });

  bot.callbackQuery(/^create:([1-4]):(16|24|32)$/, async (context) => {
    const state = states.get(sessionKey(context));
    if (state?.kind !== "select-players") {
      await context.answerCallbackQuery({ text: "Создание турнира уже завершено", show_alert: true });
      return;
    }
    await context.answerCallbackQuery({ text: "Генерирую расписание…" });
    const players = (await service.listPlayers()).filter((player) => state.selectedIds.has(player.id));
    const tournament = await service.create({
      name: `Americano ${new Date().toLocaleDateString("ru-RU")}`,
      players,
      courts: Number(context.match[1]),
      pointsPerMatch: Number(context.match[2]),
    });
    states.delete(sessionKey(context));
    await deleteCurrent(context);
    await clearMenu(context);
    await continueTournament(context, tournament);
  });

  bot.callbackQuery(/^result:([^:]+):([^:]+):(\d+)$/, async (context) => {
    const tournamentId = context.match[1]!;
    const matchId = context.match[2]!;
    const score = Number(context.match[3]);
    await serialized(tournamentId, async () => {
      const tournament = await service.findById(tournamentId);
      const round = tournament?.rounds.find((item) => item.matches.some((match) => match.id === matchId));
      const match = round?.matches.find((item) => item.id === matchId);
      if (!tournament || !round || !match) {
        await context.answerCallbackQuery({ text: "Матч не найден", show_alert: true });
        await deleteCurrent(context);
        return;
      }
      if (tournament.cancelled) {
        await context.answerCallbackQuery({ text: "Турнир отменён", show_alert: true });
        await deleteCurrent(context);
        return;
      }
      if (match.team1Score !== undefined || match.team2Score !== undefined) {
        await context.answerCallbackQuery({ text: "Счёт этого матча уже сохранён" });
        await deleteCurrent(context);
        return;
      }
      const opponentScore = match.pointsToPlay - score;
      if (opponentScore < 0) {
        await context.answerCallbackQuery({ text: "Некорректный счёт", show_alert: true });
        return;
      }
      const updated = await service.recordScore(tournamentId, matchId, score, opponentScore);
      await context.answerCallbackQuery({ text: `${score}:${opponentScore} сохранён` });
      await deleteCurrent(context);
      const updatedRound = updated.rounds.find((item) => item.number === round.number)!;
      const complete = updatedRound.matches.every((item) =>
        item.team1Score !== undefined && item.team2Score !== undefined
      );
      if (complete) await continueTournament(context, updated);
    });
  });

  bot.callbackQuery("menu:profile", async (context) => {
    await context.answerCallbackQuery();
    const player = await recognize(context);
    if (!player) {
      await render(context, "Твой Telegram ещё не привязан к игроку.", new InlineKeyboard()
        .text("➕ Создать мой профиль", "player:add-self").row()
        .text("🏠 Главное меню", "menu:main"));
      return;
    }
    await render(context, formatStatistics(await service.statisticsFor(player)), homeKeyboard());
  });

  bot.callbackQuery("menu:statistics", async (context) => {
    await context.answerCallbackQuery();
    states.delete(sessionKey(context));
    const active = (await service.leaderboard()).filter((entry) => entry.gamesPlayed > 0);
    const lines = active.length === 0 ? ["Пока нет сыгранных матчей."] : active.slice(0, 15).map((entry, index) =>
      `${index + 1}. ${entry.player.name} — ${differenceText(entry.pointsDifference)}, ` +
      `${entry.wins} побед, ${entry.gamesPlayed} матчей`
    );
    const keyboard = new InlineKeyboard()
      .text("🔎 Статистика игрока", "statistics:search").row()
      .text("🏠 Главное меню", "menu:main");
    await render(context, `📊 Рейтинг по разнице очков\n\n${lines.join("\n")}`, keyboard);
  });

  bot.callbackQuery("statistics:search", async (context) => {
    await context.answerCallbackQuery();
    await clearEgorMessages(context);
    await showStatisticsSearch(context);
  });

  bot.callbackQuery(/^statistics:player:([^:]+)$/, async (context) => {
    await context.answerCallbackQuery();
    const player = (await service.listPlayers()).find((candidate) => candidate.id === context.match[1]);
    if (!player) {
      await showMain(context, "Игрок не найден.");
      return;
    }
    await showPlayerStatistics(context, player);
  });

  bot.on("message:text", async (context) => {
    const state = states.get(sessionKey(context));
    if (state?.kind === "find-statistics") {
      await deleteCurrent(context);
      await searchStatistics(context, context.message.text);
      return;
    }
    if (state?.kind === "egor") {
      const value = context.message.text.trim();
      await deleteCurrent(context);
      if (!/^\d+$/.test(value)) {
        try {
          await context.api.editMessageText(
            state.chatId,
            state.promptMessageId,
            "Введи количество ошибок целым неотрицательным числом:",
            { reply_markup: egorKeyboard() },
          );
        } catch {
          await clearEgorMessages(context);
        }
        return;
      }
      await service.addEgorMistakes(Number(value));
      await clearEgorMessages(context);
      return;
    }
    if (state?.kind === "add-player") {
      const username = context.message.text.match(/(?:^|\s)@([A-Za-z0-9_]{5,32})\s*$/);
      const name = context.message.text.replace(/(?:^|\s)@[A-Za-z0-9_]{5,32}\s*$/, "").trim();
      try {
        const player = await service.createPlayer(name, username ? { username: username[1] } : undefined);
        states.delete(sessionKey(context));
        await deleteCurrent(context);
        await showMain(context, `Игрок ${player.name} сохранён ✅`, false);
      } catch (error) {
        await deleteCurrent(context);
        await render(context,
          `${error instanceof Error ? error.message : "Не удалось сохранить игрока"}\n\nОтправь другое имя игрока:`,
          homeKeyboard(),
          false,
        );
      }
      return;
    }
    // An administrator bot sees ordinary conversation too. Leave it alone.
    if (context.chat.type === "group" || context.chat.type === "supergroup") return;
    await deleteCurrent(context);
    await showMain(context, undefined, false);
  });

  bot.catch(({ error, ctx }) => console.error("Telegram bot error", {
    updateId: ctx.update.update_id,
    name: error instanceof Error ? error.name : "UnknownError",
    ...(error instanceof GrammyError ? {
      method: error.method, code: error.error_code, description: error.description,
    } : {}),
  }));
  return bot;
}
