// Portfolio parlay builder

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
function smooth(x, anchor, slope) {
  return 1 / (1 + Math.exp(-x * slope * 6)) * (1 - anchor) + anchor;
}

function legProbabilityFor(p) {
  switch (p.market) {
    case "hit_1":       return clamp(0.55 * p.floor + 0.45 * p.projection, 0, 1);
    case "hit_2":       return clamp(0.5 * p.floor + 0.5 * p.projection, 0, 1);
    case "home_run":    return clamp(0.7 * p.projection + 0.3 * p.floor, 0, 1);
    case "total_bases": return clamp(smooth((p.projection - 1.5) / 1.2, 0.4, 0.75), 0, 1);
    case "hrr":         return clamp(smooth((p.projection - 1.5) / 1.2, 0.4, 0.75), 0, 1);
    case "strikeouts":  return clamp(smooth((p.projection - 5.5) / 3.0, 0.4, 0.8), 0, 1);
    default: return 0.5;
  }
}

function probToAmerican(p) {
  if (p <= 0) return "+∞";
  if (p >= 1) return "-∞";
  const dec = 1 / p;
  const american = dec >= 2 ? Math.round((dec - 1) * 100) : -Math.round(100 / (dec - 1));
  return american > 0 ? `+${american}` : `${american}`;
}

function breakEvenProbForLegs(n) {
  return Math.pow(0.545, n);
}

function toLeg(p, reason) {
  return {
    predictionId: p.id,
    player: p.player_name,
    market: p.market,
    gamePk: p.game_pk,
    legProb: legProbabilityFor(p),
    projection: p.projection,
    confidence: p.confidence,
    reason,
  };
}

function assembleParlay(name, strategy, legs, minLegs = 4) {
  if (legs.length < minLegs) return null;
  const combined = legs.reduce((a, l) => a * l.legProb, 1);
  const be = breakEvenProbForLegs(legs.length);
  return {
    name, strategy, legs,
    combinedProb: combined,
    breakEvenProb: be,
    edge: combined - be,
    fairAmericanOdds: probToAmerican(combined),
  };
}

function pickDiverse(pool, n, opts = {}) {
  const { maxPerGame = 2, maxPerPlayer = 1, bannedPlayerIds = new Set() } = opts;
  const byGame = new Map();
  const byPlayer = new Map();
  const out = [];
  for (const p of pool) {
    if (out.length >= n) break;
    if (bannedPlayerIds.has(p.player_id)) continue;
    if ((byGame.get(p.game_pk) ?? 0) >= maxPerGame) continue;
    if ((byPlayer.get(p.player_id) ?? 0) >= maxPerPlayer) continue;
    out.push(p);
    byGame.set(p.game_pk, (byGame.get(p.game_pk) ?? 0) + 1);
    byPlayer.set(p.player_id, (byPlayer.get(p.player_id) ?? 0) + 1);
  }
  return out;
}

export function buildParlays(predictions) {
  const pool = predictions.filter((p) => p.data_quality === "ok");
  if (pool.length === 0) return [];

  const ranked = [...pool]
    .map((p) => ({ ...p, _legProb: legProbabilityFor(p) }))
    .sort((a, b) => b._legProb - a._legProb || b.confidence - a.confidence);

  const parlays = [];

  // 1) Safety Net
  {
    const cands = ranked.filter((p) => p.market === "hit_1" || p.market === "hrr");
    const legs = pickDiverse(cands, 5, { maxPerGame: 1 }).map((p) => toLeg(p, "high-floor consistency"));
    const par = assembleParlay("Safety Net", "5 legs of the highest-floor 1+ hit / HRR spots, max 1 per game.", legs);
    if (par) parlays.push(par);
  }

  // 2) Balanced Mixer
  {
    const seenMarkets = new Set();
    const legs = [];
    for (const p of ranked) {
      if (legs.length >= 4) break;
      if (seenMarkets.has(p.market)) continue;
      if (legs.some((l) => l.gamePk === p.game_pk)) continue;
      legs.push(toLeg(p, "top rec-score in its market"));
      seenMarkets.add(p.market);
    }
    const par = assembleParlay("Balanced Mixer", "4 legs across 4 different markets and 4 different games.", legs);
    if (par) parlays.push(par);
  }

  // 3) Pitcher Lean
  {
    const ks = ranked.filter((p) => p.market === "strikeouts").slice(0, 2);
    const hits = pickDiverse(
      ranked.filter((p) => p.market === "hit_1" && !ks.some((k) => k.game_pk === p.game_pk)),
      2, { maxPerGame: 1 }
    );
    const legs = [...ks, ...hits].map((p) =>
      toLeg(p, p.market === "strikeouts" ? "starter K matchup" : "safe hit outside a K game")
    );
    const par = assembleParlay("Pitcher Lean", "2 K props + 2 safe 1+ hit legs in unrelated games.", legs);
    if (par) parlays.push(par);
  }

  // 4) Slugger Stack
  {
    const tb = ranked.filter((p) => p.market === "total_bases").slice(0, 3);
    const hr = ranked.filter((p) => p.market === "home_run" && p.verdict === "strong").slice(0, 2);
    const combined = [...tb, ...hr];
    const legs = pickDiverse(combined, 4, { maxPerGame: 2 }).map((p) =>
      toLeg(p, p.market === "home_run" ? "HR verdict: beats Park AND Vegas" : "top total-bases spot")
    );
    const par = assembleParlay("Slugger Stack", "Total Bases + HR mix. HR legs must beat both Park AND Vegas.", legs);
    if (par) parlays.push(par);
  }

  // 5) Leverage
  {
    const cands = ranked.filter((p) => legProbabilityFor(p) > 0.5);
    const legs = pickDiverse(cands, 6, { maxPerGame: 2 }).map((p) => toLeg(p, "positive edge vs -120 juice"));
    const par = assembleParlay("Leverage 6-leg", "6 legs, each with modeled edge over typical -120 pricing. Highest payoff, highest variance.", legs);
    if (par) parlays.push(par);
  }

  return parlays;
}

// Standalone HR-prospect parlays (2-3 legs), separate from the 5 core
// portfolio parlays above. Same underlying model/probability — just
// concentrated on home runs, diversified by player and game, ranked by our
// own rec_score (never Vegas).
export function buildHRParlays(predictions) {
  const pool = predictions.filter((p) => p.market === "home_run" && p.data_quality === "ok");
  if (pool.length === 0) return [];

  const ranked = [...pool].sort((a, b) => (b.rec_score ?? b.confidence) - (a.rec_score ?? a.confidence));

  const templates = [
    { name: "HR Prospects — Top 2", size: 2 },
    { name: "HR Prospects — Trio A", size: 3 },
    { name: "HR Prospects — Trio B", size: 3 },
  ];

  const used = new Set();
  const parlays = [];

  for (const t of templates) {
    const legs = [];
    for (const p of ranked) {
      if (legs.length >= t.size) break;
      if (used.has(p.player_id)) continue;
      if (legs.some((l) => l.gamePk === p.game_pk)) continue;
      legs.push(toLeg(p, p.verdict === "strong" ? "model projects above park baseline" : "top HR confidence"));
    }
    if (legs.length < t.size) continue;
    for (const l of legs) used.add(pool.find((p) => p.id === l.predictionId)?.player_id);
    const par = assembleParlay(t.name, `${t.size}-leg home run parlay from our own model's top HR confidence scores.`, legs, 2);
    if (par) parlays.push(par);
  }

  return parlays;
}