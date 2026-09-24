import { TournamentGenerator } from "./generator";
import { formatTournament } from "./bot/formatTournament";

const names = ["Анна", "Борис", "Вера", "Глеб", "Дарья", "Егор", "Жанна", "Илья"];
const tournament = new TournamentGenerator().generate({
  name: "Вечерний Americano",
  players: names.map((name, index) => ({ id: String(index + 1), name })),
  courts: 2,
  pointsPerMatch: 32,
});

console.log(formatTournament(tournament));
