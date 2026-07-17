const db = globalThis.__B44_DB__ || { entities: new Proxy({}, { get: () => ({ filter: async () => [], deleteMany: async () => {}, bulkCreate: async () => {} }) }) };
import { todayIsoDate, currentMlbSeason } from "@/data/mlb-api";
import { loadGames } from "@/data/game-loader";
import { buildPlayerDataApi } from "@/builders/player-data-builder";
import { buildHitterFeatures } from "@/features/hitter-features";
import { buildPitcherFeatures } from "@/features/pitcher-features";
import { scoreHitter } from "@/models/hitter-model";
import { scorePitcher } from "@/models/pitcher-model";
import { buildPrediction } from "@/projection/projection-builder";

export async function runAnalysis(dateArg, onProgress) {
  const date = dateArg || todayIsoDate();
  const season = currentMlbSeason(new Date(date));
  const log = (message) => onProgress?.(message);
  log("Loading games...");
  const games = await loadGames(date);
  if (!games.length) return { date, games: 0, predictions: 0, excluded: 0, message: "No games scheduled." };
  const api = buildPlayerDataApi();
  const predictions = [];
  const excluded = [];
  for (const game of games) {
    for (const side of ["home", "away"]) {
      const home = side === "home";
      const teamId = home ? game.home_team_id : game.away_team_id;
      const teamName = home ? game.home_team_name : game.away_team_name;
      const opponentPitcherId = home ? game.away_probable_pitcher_id : game.home_probable_pitcher_id;
      const lineup = home ? game.home_lineup_players : game.away_lineup_players;
      for (const player of lineup ?? []) {
        try {
          const data = await api.hitter({ ...player, teamId, teamName }, season, opponentPitcherId, teamId);
          if (!data.season && !data.recent) { excluded.push({ game_date: date, player_id: player.id, player_name: player.fullName, reason: "No hitting stats available" }); continue; }
          const features = buildHitterFeatures(data, game);
          for (const score of scoreHitter(features, player.fullName)) predictions.push(buildPrediction({ game, player: { ...player, teamId, teamName }, playerType: "hitter", score, features, date }));
        } catch (error) { excluded.push({ game_date: date, player_id: player.id, player_name: player.fullName, reason: `Error: ${error.message}` }); }
      }
      const pitcherId = home ? game.home_probable_pitcher_id : game.away_probable_pitcher_id;
      const pitcherName = home ? game.home_probable_pitcher_name : game.away_probable_pitcher_name;
      const opponentTeamId = home ? game.away_team_id : game.home_team_id;
      if (!pitcherId || !pitcherName) continue;
      try {
        const data = await api.pitcher(pitcherId, season, opponentTeamId);
        if (!data.season) continue;
        const features = buildPitcherFeatures(data);
        for (const score of scorePitcher(features, pitcherName)) predictions.push(buildPrediction({ game, player: { id: pitcherId, fullName: pitcherName, teamId, teamName }, playerType: "pitcher", score, features, date }));
      } catch (error) { excluded.push({ game_date: date, player_id: pitcherId, player_name: pitcherName, reason: `Error: ${error.message}` }); }
    }
  }
  log(`Saving ${predictions.length} predictions...`);
  await db.entities.Game.bulkCreate(games);
  if (predictions.length) await db.entities.Prediction.bulkCreate(predictions);
  if (excluded.length) await db.entities.ExcludedPlayer.bulkCreate(excluded);
  return { date, games: games.length, predictions: predictions.length, excluded: excluded.length, message: `Analysis complete: ${games.length} games, ${predictions.length} predictions, ${excluded.length} excluded.` };
}
