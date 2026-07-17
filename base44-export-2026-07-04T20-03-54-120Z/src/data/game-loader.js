import { fetchGameLineup, fetchSchedule } from "./mlb-api";
export async function loadGames(date) {
  const games = await fetchSchedule(date);
  return Promise.all(games.map(async (game) => { const lineup = await fetchGameLineup(game.game_pk); return { ...game, home_lineup_players: lineup.home, away_lineup_players: lineup.away, home_lineup: lineup.home.map((p) => p.id), away_lineup: lineup.away.map((p) => p.id) }; }));
}
