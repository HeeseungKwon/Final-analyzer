import {
  fetchSchedule,
  fetchGameLineup,
  fetchHitterStats,
  fetchHitterRecent,
  fetchPitcherStats,
  fetchTeamHittingSO,
  fetchBoxscore,
  currentMlbSeason,
} from "@/lib/mlb-api";
import { scoreHitter, scorePitcher, parkFactorFor } from "@/lib/scoring";
import { scoreHitterLegacy, scorePitcherLegacy } from "@/lib/scoring-legacy";

const PORTFOLIO_MARKET_LIMITS = {
  hit_2: 10,
  hrr_2: 12,
  hrr_3: 10,
  total_bases: 12,
  home_run: 8,
  strikeouts: 8,
};

const PORTFOLIO_MIN_CONFIDENCE = {
  hit_2: 60,
  hrr_2: 58,
  hrr_3: 55,
  total_bases: 58,
  home_run: 62,
  strikeouts: 60,
};

function expectedPAForBattingOrder(order) {
  if (!order || order <= 0) return 3.8;
  if (order <= 2) return 4.5;
  if (order <= 5) return 4.2;
  if (order <= 7) return 3.9;
  return 3.6;
}

function findPlayerSide(box, playerId) {
  if (box.teams?.home?.players?.[`ID${playerId}`]) return "home";
  if (box.teams?.away?.players?.[`ID${playerId}`]) return "away";
  return null;
}

function evaluateHitterMarket(market, batting) {
  if (!batting) return null;
  const hits = batting.hits ?? 0;
  const runs = batting.runs ?? 0;
  const rbi = batting.rbi ?? 0;
  const doubles = batting.doubles ?? 0;
  const triples = batting.triples ?? 0;
  const hr = batting.homeRuns ?? 0;
  const singles = Math.max(0, hits - doubles - triples - hr);
  const tb = singles + doubles * 2 + triples * 3 + hr * 4;
  switch (market) {
    case "hit_2": return hits >= 2;
    case "hrr_2": return hits + runs + rbi >= 3;
    case "hrr_3": return hits + runs + rbi >= 4;
    case "total_bases": return tb >= 2;
    case "home_run": return hr >= 1;
    default: return null;
  }
}

function evaluatePitcherMarket(market, pitching) {
  if (!pitching) return null;
  if (market === "strikeouts") return (pitching.strikeOuts ?? 0) >= 7;
  return null;
}

function keyForPick(p) {
  return `${p.game_pk}:${p.player_id}:${p.market}`;
}

function summarize(picks) {
  const graded = picks.filter((p) => p.hit !== null);
  const hits = graded.filter((p) => p.hit === true).length;
  return {
    recommended: picks.length,
    graded: graded.length,
    hits,
    hitRate: graded.length > 0 ? hits / graded.length : null,
  };
}

function selectCappedPortfolio(picks) {
  const GLOBAL_MAX = 66;
  const MAX_PER_PLAYER = 2;
  const MAX_PER_GAME = 6;

  const sorted = [...picks]
    .filter((p) => (p.confidence ?? 0) >= (PORTFOLIO_MIN_CONFIDENCE[p.market] ?? 58))
    .sort((a, b) => (b.rec_score ?? 0) - (a.rec_score ?? 0));

  const byMarket = new Map();
  const byPlayer = new Map();
  const byGame = new Map();
  const out = [];

  for (const p of sorted) {
    if (out.length >= GLOBAL_MAX) break;

    const marketCount = byMarket.get(p.market) ?? 0;
    if (marketCount >= (PORTFOLIO_MARKET_LIMITS[p.market] ?? 10)) continue;

    const playerCount = byPlayer.get(p.player_id) ?? 0;
    if (playerCount >= MAX_PER_PLAYER) continue;

    const gameCount = byGame.get(p.game_pk) ?? 0;
    if (gameCount >= MAX_PER_GAME) continue;

    out.push(p);
    byMarket.set(p.market, marketCount + 1);
    byPlayer.set(p.player_id, playerCount + 1);
    byGame.set(p.game_pk, gameCount + 1);
  }

  return out;
}

export async function runOneTimeABComparison(date, onProgress) {
  const log = (m) => onProgress?.(m);
  const season = currentMlbSeason(new Date(date));

  log("A/B: fetching schedule...");
  const games = await fetchSchedule(date);
  if (games.length === 0) {
    return {
      date,
      legacy: summarize([]),
      modern: summarize([]),
      overlapCount: 0,
      legacyOnly: [],
      modernOnly: [],
      note: "No games for this date.",
    };
  }

  for (const g of games) {
    const lineup = await fetchGameLineup(g.game_pk);
    g.home_lineup_players = lineup.home;
    g.away_lineup_players = lineup.away;
  }

  const teamHitKCache = new Map();
  const pitcherStatsCache = new Map();
  const hitterStatsCache = new Map();
  const hitterRecentCache = new Map();

  async function getTeamHitK(teamId) {
    if (!teamHitKCache.has(teamId)) {
      const t = await fetchTeamHittingSO(teamId, season);
      teamHitKCache.set(teamId, t?.k_percent ?? null);
    }
    return teamHitKCache.get(teamId);
  }

  async function getPitcherStats(pid) {
    if (!pid) return null;
    if (!pitcherStatsCache.has(pid)) {
      pitcherStatsCache.set(pid, await fetchPitcherStats(pid, season));
    }
    return pitcherStatsCache.get(pid);
  }

  async function getHitterStats(pid) {
    if (!hitterStatsCache.has(pid)) {
      hitterStatsCache.set(pid, await fetchHitterStats(pid, season));
    }
    return hitterStatsCache.get(pid);
  }

  async function getHitterRecent(pid) {
    if (!hitterRecentCache.has(pid)) {
      hitterRecentCache.set(pid, await fetchHitterRecent(pid, season, 15));
    }
    return hitterRecentCache.get(pid);
  }

  const legacyPicks = [];
  const modernPicks = [];

  let processed = 0;
  for (const g of games) {
    processed += 1;
    log(`A/B scoring ${processed}/${games.length}: ${g.away_team_name} @ ${g.home_team_name}`);

    for (const side of ["home", "away"]) {
      const teamId = side === "home" ? g.home_team_id : g.away_team_id;
      const teamName = side === "home" ? g.home_team_name : g.away_team_name;
      const oppSP = side === "home" ? g.away_probable_pitcher_id : g.home_probable_pitcher_id;
      const lineupPlayers = side === "home" ? g.home_lineup_players : g.away_lineup_players;

      const oppSPStats = await getPitcherStats(oppSP);
      const oppSPk = oppSPStats?.k_percent ?? null;
      const oppSPhrPerBF = oppSPStats && (oppSPStats.bf ?? 0) > 0
        ? (oppSPStats.hr_allowed ?? 0) / oppSPStats.bf
        : null;

      for (const lp of lineupPlayers) {
        const [seasonStats, recent] = await Promise.all([getHitterStats(lp.id), getHitterRecent(lp.id)]);
        if (!seasonStats && !recent) continue;

        const ctx = {
          season: seasonStats,
          recent,
          oppPitcherK: oppSPk,
          oppPitcherHrPerBF: oppSPhrPerBF,
          expectedPA: expectedPAForBattingOrder(lp.battingOrder),
          battingOrder: lp.battingOrder,
          parkFactor: parkFactorFor(g.home_team_id),
          vegasHrProb: null,
        };

        const legacyScores = scoreHitterLegacy(lp.fullName, ctx).filter((s) => s.recommended);
        const modernScores = scoreHitter(lp.fullName, ctx).filter((s) => s.recommended);

        for (const s of legacyScores) {
          legacyPicks.push({
            algorithm: "legacy",
            game_pk: g.game_pk,
            game_date: date,
            player_id: lp.id,
            player_name: lp.fullName,
            team_name: teamName,
            market: s.market,
            rec_score: s.recScore,
            confidence: s.confidence,
            hit: null,
          });
        }
        for (const s of modernScores) {
          modernPicks.push({
            algorithm: "modern",
            game_pk: g.game_pk,
            game_date: date,
            player_id: lp.id,
            player_name: lp.fullName,
            team_name: teamName,
            market: s.market,
            rec_score: s.recScore,
            confidence: s.confidence,
            hit: null,
          });
        }
      }
    }

    for (const side of ["home", "away"]) {
      const pid = side === "home" ? g.home_probable_pitcher_id : g.away_probable_pitcher_id;
      const pname = side === "home" ? g.home_probable_pitcher_name : g.away_probable_pitcher_name;
      const teamName = side === "home" ? g.home_team_name : g.away_team_name;
      const oppTeamId = side === "home" ? g.away_team_id : g.home_team_id;
      if (!pid || !pname) continue;

      const st = await getPitcherStats(pid);
      if (!st) continue;

      const oppTeamKRate = await getTeamHitK(oppTeamId);
      const pctx = {
        season: st,
        oppTeamK: oppTeamKRate,
        expectedIP: 5.5,
      };

      const legacyScores = scorePitcherLegacy(pname, pctx).filter((s) => s.recommended);
      const modernScores = scorePitcher(pname, pctx).filter((s) => s.recommended);

      for (const s of legacyScores) {
        legacyPicks.push({
          algorithm: "legacy",
          game_pk: g.game_pk,
          game_date: date,
          player_id: pid,
          player_name: pname,
          team_name: teamName,
          market: s.market,
          rec_score: s.recScore,
          confidence: s.confidence,
          hit: null,
        });
      }
      for (const s of modernScores) {
        modernPicks.push({
          algorithm: "modern",
          game_pk: g.game_pk,
          game_date: date,
          player_id: pid,
          player_name: pname,
          team_name: teamName,
          market: s.market,
          rec_score: s.recScore,
          confidence: s.confidence,
          hit: null,
        });
      }
    }
  }

  log("A/B grading picks against boxscores...");
  const boxCache = new Map();
  const allPicks = [...legacyPicks, ...modernPicks];
  for (const pick of allPicks) {
    if (!boxCache.has(pick.game_pk)) {
      boxCache.set(pick.game_pk, await fetchBoxscore(pick.game_pk));
    }
    const box = boxCache.get(pick.game_pk);
    if (!box) continue;
    const side = findPlayerSide(box, pick.player_id);
    if (!side) continue;
    const player = box.teams?.[side]?.players?.[`ID${pick.player_id}`];
    const hit = pick.market === "strikeouts"
      ? evaluatePitcherMarket(pick.market, player?.stats?.pitching)
      : evaluateHitterMarket(pick.market, player?.stats?.batting);
    if (hit === null || hit === undefined) continue;
    pick.hit = hit;
  }

  const legacySummary = summarize(legacyPicks);
  const modernSummary = summarize(modernPicks);

  const legacyPortfolio = selectCappedPortfolio(legacyPicks);
  const modernPortfolio = selectCappedPortfolio(modernPicks);

  const legacyPortfolioSummary = summarize(legacyPortfolio);
  const modernPortfolioSummary = summarize(modernPortfolio);

  const legacyMap = new Map(legacyPortfolio.map((p) => [keyForPick(p), p]));
  const modernMap = new Map(modernPortfolio.map((p) => [keyForPick(p), p]));

  const overlap = [];
  for (const [k, lp] of legacyMap.entries()) {
    if (modernMap.has(k)) overlap.push(lp);
  }

  const legacyOnly = legacyPortfolio
    .filter((p) => !modernMap.has(keyForPick(p)))
    .sort((a, b) => (b.rec_score ?? 0) - (a.rec_score ?? 0));
  const modernOnly = modernPortfolio
    .filter((p) => !legacyMap.has(keyForPick(p)))
    .sort((a, b) => (b.rec_score ?? 0) - (a.rec_score ?? 0));

  return {
    date,
    legacyRaw: legacySummary,
    modernRaw: modernSummary,
    legacy: legacyPortfolioSummary,
    modern: modernPortfolioSummary,
    overlapCount: overlap.length,
    legacyOnly,
    modernOnly,
    note: "Raw model recommendations and capped portfolio recommendations are both shown. Hit rate uses graded picks with available boxscore stats.",
  };
}
