const db = globalThis.__B44_DB__ || { auth:{ isAuthenticated: async()=>false, me: async()=>null }, entities:new Proxy({}, { get:()=>({ filter:async()=>[], get:async()=>null, create:async()=>({}), update:async()=>({}), delete:async()=>({}) }) }), integrations:{ Core:{ UploadFile:async()=>({ file_url:'' }) } } };

// Grades past predictions against actual MLB box score results, then
// recomputes MarketAccuracy hit-rate buckets.

import { fetchBoxscore } from "@/lib/mlb-api";
import { buildParlays, buildHRParlays } from "@/lib/parlays";

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
    case "hit_1": return hits >= 1;
    case "hit_2": return hits >= 2;
    case "hrr": return hits + runs + rbi >= 2;
    case "total_bases": return tb >= 2;
    case "home_run": return hr >= 1;
    default: return null;
  }
}

function evaluatePitcherMarket(market, pitching) {
  if (!pitching) return null;
  const so = pitching.strikeOuts ?? 0;
  if (market === "strikeouts") return so >= 6;
  return null;
}

export async function gradeAllUngraded(onProgress) {
  const log = (m) => onProgress?.(m);
  const today = new Date().toISOString().slice(0, 10);

  log("Loading ungraded predictions...");
  const ungraded = await db.entities.Prediction.filter({ graded: false });
  const allPastPreds = ungraded.filter((p) => p.game_date < today);

  // Only grade high-confidence picks (>65) plus any pick included in one of
  // that day's parlays — keeps grading volume manageable.
  const byDate = {};
  for (const p of allPastPreds) (byDate[p.game_date] ||= []).push(p);
  const parlayIds = new Set();
  for (const date of Object.keys(byDate)) {
    const dayPreds = byDate[date];
    for (const parlay of [...buildParlays(dayPreds), ...buildHRParlays(dayPreds)]) {
      for (const leg of parlay.legs) parlayIds.add(leg.predictionId);
    }
  }
  const pastPreds = allPastPreds.filter((p) => (p.confidence ?? 0) > 65 || parlayIds.has(p.id));

  if (pastPreds.length === 0) {
    return { graded: 0, message: "No ungraded predictions from completed dates yet." };
  }

  const boxCache = new Map();
  const updates = [];

  for (const p of pastPreds) {
    if (!boxCache.has(p.game_pk)) {
      log(`Fetching result for game ${p.game_pk}...`);
      boxCache.set(p.game_pk, await fetchBoxscore(p.game_pk));
    }
    const box = boxCache.get(p.game_pk);
    if (!box) continue;
    const side = findPlayerSide(box, p.player_id);
    if (!side) continue;
    const player = box.teams[side].players[`ID${p.player_id}`];
    const hit = p.player_type === "hitter"
      ? evaluateHitterMarket(p.market, player?.stats?.batting)
      : evaluatePitcherMarket(p.market, player?.stats?.pitching);
    if (hit === null || hit === undefined) continue;
    updates.push({ id: p.id, graded: true, hit });
  }

  if (updates.length > 0) {
    log(`Saving ${updates.length} graded results...`);
    await db.entities.Prediction.bulkUpdate(updates);
  }

  log("Recomputing accuracy buckets...");
  await recomputeMarketAccuracy();

  return { graded: updates.length, message: `Graded ${updates.length} predictions from completed games.` };
}

export async function recomputeMarketAccuracy() {
  const graded = await db.entities.Prediction.filter({ graded: true });
  const buckets = {};
  for (const p of graded) {
    if (p.hit == null) continue;
    const bucket = Math.min(90, Math.max(0, Math.floor((p.confidence ?? 0) / 10) * 10));
    const key = `${p.market}_${bucket}`;
    if (!buckets[key]) buckets[key] = { market: p.market, confidence_bucket: bucket, n: 0, hits: 0 };
    buckets[key].n += 1;
    if (p.hit) buckets[key].hits += 1;
  }
  const rows = Object.values(buckets).map((b) => ({
    market: b.market,
    confidence_bucket: b.confidence_bucket,
    n_predictions: b.n,
    n_hits: b.hits,
    hit_rate: b.n > 0 ? b.hits / b.n : 0,
  }));

  const existing = await db.entities.MarketAccuracy.list();
  if (existing.length > 0) await db.entities.MarketAccuracy.deleteMany({});
  if (rows.length > 0) await db.entities.MarketAccuracy.bulkCreate(rows);
}