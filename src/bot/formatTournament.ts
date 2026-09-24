import type { Tournament } from "../domain";

export function formatTournament(tournament: Tournament): string {
  const lines = [
    `🏆 ${tournament.name}`,
    `Игроков: ${tournament.players.length}, кортов: ${tournament.courts}, очков: ${tournament.pointsPerMatch}`,
  ];
  for (const round of tournament.rounds) {
    lines.push("", `Раунд ${round.number}`);
    for (const match of round.matches) {
      lines.push(
        `Корт ${match.court}: ${match.team1.map((player) => player.name).join(" + ")} — ` +
        `${match.team2.map((player) => player.name).join(" + ")}`,
      );
    }
    if (round.restingPlayers.length > 0) {
      lines.push(`Отдыхают: ${round.restingPlayers.map((player) => player.name).join(", ")}`);
    }
  }
  return lines.join("\n");
}
