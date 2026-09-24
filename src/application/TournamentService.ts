import { randomUUID } from "node:crypto";
import type { PartnerStatistics, Player, PlayerStatistics, Team, Tournament, TournamentInput } from "../domain";
import { TournamentGenerator } from "../generator";
import type { TournamentRepository } from "../persistence/TournamentRepository";

export class TournamentService {
  constructor(
    private readonly repository: TournamentRepository,
    private readonly generator = new TournamentGenerator(),
  ) {}

  async create(input: TournamentInput): Promise<Tournament> {
    const tournament = this.generator.generate(input);
    await this.repository.save(tournament);
    return tournament;
  }

  findById(id: string): Promise<Tournament | undefined> {
    return this.repository.findById(id);
  }

  listTournaments(): Promise<Tournament[]> {
    return this.repository.findAll();
  }

  async cancel(tournamentId: string): Promise<Tournament> {
    const tournament = await this.repository.findById(tournamentId);
    if (!tournament) throw new Error("Турнир не найден");
    if (tournament.cancelled) return tournament;
    const cancelled = { ...tournament, cancelled: true };
    await this.repository.save(cancelled);
    return cancelled;
  }

  egorMistakes(): Promise<number> {
    return this.repository.getCounter("egor_mistakes");
  }

  addEgorMistakes(amount: number): Promise<number> {
    if (!Number.isInteger(amount) || amount < 0) {
      throw new Error("Количество ошибок должно быть целым неотрицательным числом");
    }
    return this.repository.incrementCounter("egor_mistakes", amount);
  }

  listPlayers(): Promise<Player[]> {
    return this.repository.listPlayers();
  }

  async createPlayer(
    name: string,
    telegram?: { userId?: number; username?: string },
  ): Promise<Player> {
    const trimmedName = name.trim();
    if (!trimmedName) throw new Error("Имя игрока не может быть пустым");
    if (telegram) {
      const existing = telegram.userId !== undefined
        ? await this.repository.findPlayerByTelegram(telegram.userId, telegram.username)
        : (await this.repository.listPlayers()).find(
          (player) => player.telegramUsername?.toLowerCase() === telegram.username?.toLowerCase(),
        );
      if (existing) throw new Error(`Telegram уже привязан к игроку ${existing.name}`);
    }
    const player: Player = {
      id: randomUUID(),
      name: trimmedName,
      ...(telegram?.userId !== undefined ? { telegramUserId: telegram.userId } : {}),
      ...(telegram?.username ? { telegramUsername: telegram.username } : {}),
    };
    await this.repository.savePlayer(player);
    return player;
  }

  async renamePlayer(playerId: string, name: string): Promise<Player> {
    const trimmedName = name.trim();
    if (!trimmedName) throw new Error("Имя игрока не может быть пустым");
    const player = await this.repository.findPlayerById(playerId);
    if (!player) throw new Error("Игрок не найден");
    const renamed = { ...player, name: trimmedName };
    await this.repository.savePlayer(renamed);

    const rename = (candidate: Player): Player =>
      candidate.id === playerId ? { ...candidate, name: trimmedName } : candidate;
    const renameTeam = (team: Team): Team => [rename(team[0]), rename(team[1])];
    for (const tournament of await this.repository.findAll()) {
      await this.repository.save({
        ...tournament,
        players: tournament.players.map(rename),
        rounds: tournament.rounds.map((round) => ({
          ...round,
          restingPlayers: round.restingPlayers.map(rename),
          matches: round.matches.map((match) => ({
            ...match,
            team1: renameTeam(match.team1),
            team2: renameTeam(match.team2),
          })),
        })),
      });
    }
    return renamed;
  }

  async recognizePlayer(telegramUserId: number, username?: string): Promise<Player | undefined> {
    const player = await this.repository.findPlayerByTelegram(telegramUserId, username);
    if (!player || player.telegramUserId === telegramUserId) return player;
    const linked: Player = {
      ...player,
      telegramUserId,
      ...(username ? { telegramUsername: username } : {}),
    };
    await this.repository.savePlayer(linked);
    return linked;
  }

  async recordScore(
    tournamentId: string,
    matchId: string,
    team1Score: number,
    team2Score: number,
  ): Promise<Tournament> {
    const tournament = await this.repository.findById(tournamentId);
    if (!tournament) throw new Error("Турнир не найден");
    if (tournament.cancelled) throw new Error("Турнир отменён. Ввод и изменение результатов недоступны.");
    if (![team1Score, team2Score].every((score) => Number.isInteger(score) && score >= 0)) {
      throw new Error("Счёт должен состоять из двух неотрицательных целых чисел");
    }
    const targetMatch = tournament.rounds.flatMap((round) => round.matches)
      .find((match) => match.id === matchId);
    if (!targetMatch) throw new Error("Матч не найден");
    if (team1Score + team2Score !== targetMatch.pointsToPlay) {
      throw new Error(`Сумма счёта должна быть ${targetMatch.pointsToPlay}`);
    }
    targetMatch.team1Score = team1Score;
    targetMatch.team2Score = team2Score;
    await this.repository.save(tournament);
    return tournament;
  }

  async statisticsFor(player: Player): Promise<PlayerStatistics> {
    const tournaments = await this.repository.findAll();
    const scoredMatches = tournaments.filter((tournament) => !tournament.cancelled).flatMap((tournament) => tournament.rounds
      .flatMap((round) => round.matches)
      .filter((match) => match.team1Score !== undefined && match.team2Score !== undefined)
      .filter((match) => [...match.team1, ...match.team2].some((candidate) => candidate.id === player.id))
      .map((match) => ({ tournamentId: tournament.id, match })));

    let wins = 0;
    let draws = 0;
    let losses = 0;
    let pointsFor = 0;
    let pointsAgainst = 0;
    const partners = new Set<string>();
    const opponents = new Set<string>();
    const partnerStatistics = new Map<string, PartnerStatistics>();

    for (const { match } of scoredMatches) {
      const inTeam1 = match.team1.some((candidate) => candidate.id === player.id);
      const ownScore = inTeam1 ? match.team1Score! : match.team2Score!;
      const rivalScore = inTeam1 ? match.team2Score! : match.team1Score!;
      pointsFor += ownScore;
      pointsAgainst += rivalScore;
      if (ownScore > rivalScore) wins += 1;
      else if (ownScore === rivalScore) draws += 1;
      else losses += 1;
      const ownTeam = inTeam1 ? match.team1 : match.team2;
      const rivalTeam = inTeam1 ? match.team2 : match.team1;
      ownTeam.filter((candidate) => candidate.id !== player.id).forEach((candidate) => partners.add(candidate.id));
      rivalTeam.forEach((candidate) => opponents.add(candidate.id));
      const partner = ownTeam.find((candidate) => candidate.id !== player.id)!;
      const previous = partnerStatistics.get(partner.id);
      const partnerGames = (previous?.gamesPlayed ?? 0) + 1;
      const partnerWins = (previous?.wins ?? 0) + Number(ownScore > rivalScore);
      const partnerDraws = (previous?.draws ?? 0) + Number(ownScore === rivalScore);
      partnerStatistics.set(partner.id, {
        player: partner,
        gamesPlayed: partnerGames,
        wins: partnerWins,
        draws: partnerDraws,
        losses: (previous?.losses ?? 0) + Number(ownScore < rivalScore),
        pointsFor: (previous?.pointsFor ?? 0) + ownScore,
        pointsAgainst: (previous?.pointsAgainst ?? 0) + rivalScore,
        winRate: (partnerWins + partnerDraws * 0.5) / partnerGames * 100,
        averagePointsFor: ((previous?.pointsFor ?? 0) + ownScore) / partnerGames,
      });
    }

    const bestPartnerByWinRate = [...partnerStatistics.values()].sort((a, b) =>
      b.winRate - a.winRate || b.gamesPlayed - a.gamesPlayed || b.averagePointsFor - a.averagePointsFor ||
      a.player.name.localeCompare(b.player.name, "ru") || a.player.id.localeCompare(b.player.id),
    )[0];
    const bestPartnerByAveragePoints = [...partnerStatistics.values()].sort((a, b) =>
      b.averagePointsFor - a.averagePointsFor || b.gamesPlayed - a.gamesPlayed || b.winRate - a.winRate ||
      a.player.name.localeCompare(b.player.name, "ru") || a.player.id.localeCompare(b.player.id),
    )[0];
    const gamesPlayed = scoredMatches.length;
    return {
      player,
      tournamentsPlayed: new Set(scoredMatches.map(({ tournamentId }) => tournamentId)).size,
      gamesPlayed,
      wins,
      draws,
      losses,
      pointsFor,
      pointsAgainst,
      pointsDifference: pointsFor - pointsAgainst,
      averagePointsFor: gamesPlayed === 0 ? 0 : pointsFor / gamesPlayed,
      averagePointsAgainst: gamesPlayed === 0 ? 0 : pointsAgainst / gamesPlayed,
      winRate: gamesPlayed === 0 ? 0 : ((wins + draws * 0.5) / gamesPlayed) * 100,
      uniquePartners: partners.size,
      uniqueOpponents: opponents.size,
      bestPartnerByWinRate,
      bestPartnerByAveragePoints,
    };
  }

  async leaderboard(): Promise<PlayerStatistics[]> {
    const players = await this.repository.listPlayers();
    const statistics = await Promise.all(players.map((player) => this.statisticsFor(player)));
    return statistics.sort((a, b) =>
      b.pointsDifference - a.pointsDifference || b.wins - a.wins || a.player.name.localeCompare(b.player.name, "ru"),
    );
  }
}
