const db = globalThis.__B44_DB__ || { auth:{ isAuthenticated: async()=>false, me: async()=>null }, entities:new Proxy({}, { get:()=>({ filter:async()=>[], get:async()=>null, create:async()=>({}), update:async()=>({}), delete:async()=>({}) }) }), integrations:{ Core:{ UploadFile:async()=>({ file_url:'' }) } } };

// Client-side analysis runner that calls MLB API + scoring engine + persists to entities

import {
  fetchSchedule,
  fetchHitterStats,
  fetchHitterRecent,
  fetchPitcherStats,
  fetchTeamPitchingK,
  fetchTeamHittingSO,
  fetchGameLineup,
  currentMlbSeason,
  todayIsoDate,
} from "@/lib/mlb-api";
import { scoreHitter, scorePitcher, parkFactorFor } from "@/lib/scoring";

function expectedPAForBattingOrder(order) {
  if (!order || order <= 0) return 3.8;
  if (order <= 2) return 4.5;
  if (order <= 5) return 4.2;
  if (order <= 7) return 3.9;
  return 3.6;
}

export async function runAnalysis(dateArg, onProgress) {
  const date = dateArg || todayIsoDate();
  const season = currentMlbSeason(new Date(date));
  const log = (msg) => onProgress?.(msg);

  log("Fetching schedule...");
  const games = await fetchSchedule(date);
  if (games.length === 0) {
    return { date, games: 0, predictions: 0, excluded: 0, message: "No games scheduled." };
  }

  log(`Found ${games.length} games. Fetching lineups...`);

  // Try to get lineups from boxscore data
  for (const g of games) {
    try {
      const lineup = await fetchGameLineup(g.game_pk);
      g.home_lineup_players = lineup.home;
      g.away_lineup_players = lineup.away;
      g.home_lineup = lineup.home.map((p) => p.id);
      g.away_lineup = lineup.away.map((p) => p.id);
    } catch {
      // lineups not available
    }
  }

  // Clear old data for this date
  log("Clearing old data...");
  try {
    const oldGames = await db.entities.Game.filter({ game_date: date });
    if (oldGames.length > 0) await db.entities.Game.deleteMany({ game_date: date });
  } catch {}
  try {
    const oldPreds = await db.entities.Prediction.filter({ game_date: date });
    if (oldPreds.length > 0) await db.entities.Prediction.deleteMany({ game_date: date });
  } catch {}
  try {
    const oldExcl = await db.entities.ExcludedPlayer.filter({ game_date: date });
    if (oldExcl.length > 0) await db.entities.ExcludedPlayer.deleteMany({ game_date: date });
  } catch {}

  // Save games
  log("Saving games...");
  await db.entities.Game.bulkCreate(
    games.map((g) => ({
      game_pk: g.game_pk,
      game_date: g.game_date,
      game_time_utc: g.game_time_utc ?? "",
      home_team_id: g.home_team_id,
      home_team_name: g.home_team_name,
      away_team_id: g.away_team_id,
      away_team_name: g.away_team_name,
      venue_name: g.venue_name ?? "",
      home_probable_pitcher_id: g.home_probable_pitcher_id ?? 0,
      home_probable_pitcher_name: g.home_probable_pitcher_name ?? "",
      away_probable_pitcher_id: g.away_probable_pitcher_id ?? 0,
      away_probable_pitcher_name: g.away_probable_pitcher_name ?? "",
      status: g.status,
    }))
  );

  // Team K% caches
  const teamPitchK = new Map();
  const teamHitK = new Map();

  async function getTeamPitchK(id) {
    if (!teamPitchK.has(id)) {
      const r = await fetchTeamPitchingK(id, season);
      teamPitchK.set(id, r?.k_percent ?? null);
    }
    return teamPitchK.get(id);
  }

  async function getTeamHitK(id) {
    if (!teamHitK.has(id)) {
      const r = await fetchTeamHittingSO(id, season);
      teamHitK.set(id, r?.k_percent ?? null);
    }
    return teamHitK.get(id);
  }

  const pitcherKCache = new Map();
  async function getSPk(pid) {
    if (!pid) return null;
    if (!pitcherKCache.has(pid)) {
      const s = await fetchPitcherStats(pid, season);
      pitcherKCache.set(pid, s?.k_percent ?? null);
    }
    return pitcherKCache.get(pid);
  }

  const predictionRows = [];
  const excludedRows = [];
  let processedGames = 0;

  for (const g of games) {
    processedGames++;
    log(`Scoring game ${processedGames}/${games.length}: ${g.away_team_name} @ ${g.home_team_name}...`);

    for (const side of ["home", "away"]) {
      const teamId = side === "home" ? g.home_team_id : g.away_team_id;
      const oppTeamId = side === "home" ? g.away_team_id : g.home_team_id;
      const oppSP = side === "home" ? g.away_probable_pitcher_id : g.home_probable_pitcher_id;
      const lineupPlayers = side === "home" ? g.home_lineup_players : g.away_lineup_players;

      if (lineupPlayers.length === 0) {
        excludedRows.push({
          game_date: date,
          player_name: `${side === "home" ? g.home_team_name : g.away_team_name} lineup`,
          reason: "Starting lineup not available at analysis time.",
        });
        continue;
      }

      const oppSPk = await getSPk(oppSP);

      for (const lp of lineupPlayers) {
        try {
          const [seasonStats, recent] = await Promise.all([
            fetchHitterStats(lp.id, season),
            fetchHitterRecent(lp.id, season, 15),
          ]);
          if (!seasonStats && !recent) {
            excludedRows.push({ game_date: date, player_id: lp.id, player_name: lp.fullName, reason: "No hitting stats available" });
            continue;
          }
          const scores = scoreHitter(lp.fullName, {
            season: seasonStats,
            recent,
            oppPitcherK: oppSPk,
            oppBullpenK: null,
            expectedPA: expectedPAForBattingOrder(lp.battingOrder),
            battingOrder: lp.battingOrder,
            parkFactor: parkFactorFor(g.home_team_id),
            vegasHrProb: null,
          });
          for (const s of scores) {
            predictionRows.push({
              game_pk: g.game_pk,
              game_date: date,
              player_id: lp.id,
              player_name: lp.fullName,
              player_type: "hitter",
              market: s.market,
              confidence: Math.round(s.confidence * 100) / 100,
              projection: Math.round(s.projection * 10000) / 10000,
              floor: Math.round(s.floor * 10000) / 10000,
              ceiling: Math.round(s.ceiling * 10000) / 10000,
              trigger_text: s.trigger,
              trigger_strength: Math.round(s.triggerStrength * 100) / 100,
              features: JSON.stringify(s.features),
              data_quality: s.dataQuality,
              recommended: s.recommended,
              rec_score: Math.round(s.recScore * 100) / 100,
              verdict: s.verdict ?? "",
              verdict_note: s.verdictNote ?? "",
            });
          }
        } catch (e) {
          excludedRows.push({ game_date: date, player_id: lp.id, player_name: lp.fullName, reason: `Error: ${e.message}` });
        }
      }
    }

    // Pitchers
    for (const side of ["home", "away"]) {
      const pid = side === "home" ? g.home_probable_pitcher_id : g.away_probable_pitcher_id;
      const pname = side === "home" ? g.home_probable_pitcher_name : g.away_probable_pitcher_name;
      const oppTeamId = side === "home" ? g.away_team_id : g.home_team_id;
      if (!pid || !pname) {
        excludedRows.push({
          game_date: date,
          player_name: `${side === "home" ? g.home_team_name : g.away_team_name} starter`,
          reason: "Probable pitcher not announced",
        });
        continue;
      }
      try {
        const st = await fetchPitcherStats(pid, season);
        if (!st) {
          excludedRows.push({ game_date: date, player_id: pid, player_name: pname, reason: "No pitching stats available" });
          continue;
        }
        const oppTeamKRate = await getTeamHitK(oppTeamId);
        const scores = scorePitcher(pname, {
          season: st,
          oppTeamK: oppTeamKRate,
          expectedIP: 5.5,
        });
        for (const s of scores) {
          predictionRows.push({
            game_pk: g.game_pk,
            game_date: date,
            player_id: pid,
            player_name: pname,
            player_type: "pitcher",
            market: s.market,
            confidence: Math.round(s.confidence * 100) / 100,
            projection: Math.round(s.projection * 10000) / 10000,
            floor: Math.round(s.floor * 10000) / 10000,
            ceiling: Math.round(s.ceiling * 10000) / 10000,
            trigger_text: s.trigger,
            trigger_strength: Math.round(s.triggerStrength * 100) / 100,
            features: JSON.stringify(s.features),
            data_quality: s.dataQuality,
            recommended: s.recommended,
            rec_score: Math.round(s.recScore * 100) / 100,
            verdict: s.verdict ?? "",
            verdict_note: s.verdictNote ?? "",
          });
        }
      } catch (e) {
        excludedRows.push({ game_date: date, player_id: pid, player_name: pname, reason: `Error: ${e.message}` });
      }
    }
  }

  // Persist predictions in batches
  log(`Saving ${predictionRows.length} predictions...`);
  const BATCH = 50;
  for (let i = 0; i < predictionRows.length; i += BATCH) {
    await db.entities.Prediction.bulkCreate(predictionRows.slice(i, i + BATCH));
  }

  // Persist excluded
  if (excludedRows.length > 0) {
    log(`Saving ${excludedRows.length} exclusions...`);
    await db.entities.ExcludedPlayer.bulkCreate(excludedRows);
  }

  log("Done!");
  return {
    date,
    games: games.length,
    predictions: predictionRows.length,
    excluded: excludedRows.length,
    message: `Analysis complete: ${games.length} games, ${predictionRows.length} predictions, ${excludedRows.length} excluded.`,
  };
}