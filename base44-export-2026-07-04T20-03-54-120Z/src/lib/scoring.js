// Deterministic scoring for MLB player props

export const MARKET_LABELS = {
  hit_1: "1+ Hit",
  hit_2: "2+ Hits",
  hrr: "Hits+Runs+RBIs 1.5",
  total_bases: "Total Bases 1.5",
  home_run: "Home Run",
  strikeouts: "Strikeouts 5.5",
};

export const MARKET_PROJECTION_UNIT = {
  hit_1: { unit: "probability", label: "P(1+ hit)", description: "Probability the hitter records at least 1 hit." },
  hit_2: { unit: "probability", label: "P(2+ hits)", description: "Probability the hitter records 2 or more hits." },
  home_run: { unit: "probability", label: "P(HR)", description: "Probability the hitter hits at least 1 home run." },
  total_bases: { unit: "count", label: "Exp. total bases", description: "Expected total bases (1B=1, 2B=2, 3B=3, HR=4). Line = 1.5." },
  hrr: { unit: "count", label: "Exp. H+R+RBI", description: "Expected Hits + Runs + RBIs combined. Line = 1.5." },
  strikeouts: { unit: "count", label: "Exp. K", description: "Expected strikeouts for the starting pitcher. Line = 5.5." },
};

function binomAtLeast(n, p, k) {
  if (n <= 0) return 0;
  p = Math.max(0, Math.min(1, p));
  let logC = 0;
  const logP = Math.log(p || 1e-9);
  const log1p = Math.log(1 - p || 1e-9);
  const pmf = (i) => Math.exp(logC + i * logP + (n - i) * log1p);
  let cum = 0;
  for (let i = 0; i <= n; i++) {
    if (i === 0) {
      cum += Math.exp(n * log1p);
    } else {
      logC += Math.log((n - i + 1) / i);
      cum += pmf(i);
    }
    if (i + 1 === k) return Math.max(0, Math.min(1, 1 - cum));
  }
  return 0;
}

function blend(season, recent, wRecent = 0.35) {
  if (season == null && recent == null) return null;
  if (season == null) return recent;
  if (recent == null) return season;
  return season * (1 - wRecent) + recent * wRecent;
}

function toConfidence(prob, anchor = 0.5, slope = 120) {
  const c = 50 + slope * (prob - anchor);
  return Math.max(0, Math.min(100, c));
}

function baseFeatures(ctx, extras = {}) {
  return {
    expectedPA: ctx.expectedPA,
    battingOrder: ctx.battingOrder ?? null,
    oppPitcherK: ctx.oppPitcherK ?? null,
    parkFactor: ctx.parkFactor ?? 100,
    ...extras,
  };
}

// Park factors
const HR_PARK_FACTOR = {
  115: 118, 113: 116, 140: 113, 143: 111, 147: 110, 158: 108, 110: 108,
  112: 106, 141: 105, 111: 104, 109: 102, 144: 102, 120: 101, 108: 101,
  142: 100, 145: 99, 119: 99, 135: 97, 117: 96, 118: 96, 139: 95,
  116: 94, 134: 93, 138: 92, 133: 92, 114: 91, 136: 90, 121: 89, 146: 87, 137: 85,
};

export function parkFactorFor(homeTeamId) {
  if (homeTeamId == null) return 100;
  return HR_PARK_FACTOR[homeTeamId] ?? 100;
}

function expectedPAForBattingOrder(order) {
  if (!order || order <= 0) return 3.8;
  if (order <= 2) return 4.5;
  if (order <= 5) return 4.2;
  if (order <= 7) return 3.9;
  return 3.6;
}

export function scoreHitter(name, ctx) {
  const out = [];
  const dqBase = !ctx.season && !ctx.recent ? "missing" :
    ctx.season?.quality === "partial" || ctx.recent?.quality === "partial" || !ctx.season || !ctx.recent ? "partial" : "ok";

  const seasonAvg = ctx.season?.avg ?? null;
  const recentAvg = ctx.recent && ctx.recent.ab >= 20 ? ctx.recent.avg : null;
  const avg = blend(seasonAvg, recentAvg) ?? 0;

  const seasonSlg = ctx.season?.slg ?? null;
  const recentSlg = ctx.recent && ctx.recent.ab >= 20 ? ctx.recent.slg : null;
  const slg = blend(seasonSlg, recentSlg) ?? 0;

  const hrRateSeason = ctx.season && ctx.season.pa > 0 ? ctx.season.home_runs / ctx.season.pa : null;
  const hrRateRecent = ctx.recent && ctx.recent.pa >= 30 ? ctx.recent.home_runs / ctx.recent.pa : null;
  const hrRate = blend(hrRateSeason, hrRateRecent) ?? 0;

  const hrrRateSeason = ctx.season && ctx.season.pa > 0 ? (ctx.season.hits + ctx.season.runs + ctx.season.rbi) / ctx.season.pa : null;
  const hrrRateRecent = ctx.recent && ctx.recent.pa >= 30 ? (ctx.recent.hits + ctx.recent.runs + ctx.recent.rbi) / ctx.recent.pa : null;
  const hrrRate = blend(hrrRateSeason, hrrRateRecent) ?? 0;

  const leagueK = 0.225;
  const oppK = ctx.oppPitcherK ?? leagueK;
  const matchupMult = 1 + (leagueK - oppK) * 1.2;

  const adjAvg = Math.max(0, avg * matchupMult);
  const adjSlg = Math.max(0, slg * matchupMult);
  const adjHR = Math.max(0, hrRate * matchupMult);
  const adjHrr = Math.max(0, hrrRate * matchupMult);

  const expectedAB = Math.max(3, Math.round(ctx.expectedPA * 0.88));

  const triggers = [];
  if (recentAvg && seasonAvg && recentAvg - seasonAvg > 0.04) triggers.push(`hot last 15 (.${(recentAvg * 1000).toFixed(0)})`);
  if (recentAvg && seasonAvg && seasonAvg - recentAvg > 0.04) triggers.push(`cold recent (.${(recentAvg * 1000).toFixed(0)})`);
  if (oppK && oppK < leagueK - 0.03) triggers.push(`weak-K pitcher (${(oppK * 100).toFixed(1)}%)`);
  if (oppK && oppK > leagueK + 0.03) triggers.push(`strikeout pitcher (${(oppK * 100).toFixed(1)}%)`);
  const trigger = triggers[0] ?? `season .${(avg * 1000).toFixed(0)} / ${(hrRate * 100).toFixed(1)}% HR`;
  const formDelta = recentAvg && seasonAvg ? (recentAvg - seasonAvg) * 4 : 0;
  const triggerStrength = Math.max(-1, Math.min(1, (matchupMult - 1) * 2 + formDelta));

  // hit_1
  {
    const p = 1 - Math.pow(1 - adjAvg, expectedAB);
    const floor = 1 - Math.pow(1 - adjAvg * 0.85, expectedAB - 1);
    const ceiling = 1 - Math.pow(1 - adjAvg * 1.15, expectedAB + 1);
    out.push({
      market: "hit_1", confidence: toConfidence(p, 0.65, 130), projection: p,
      floor, ceiling, trigger, triggerStrength,
      features: baseFeatures(ctx, { avg, adjAvg, expectedAB, oppK, matchupMult }),
      dataQuality: dqBase, recommended: false, recScore: 0,
    });
  }
  // hit_2
  {
    const p = binomAtLeast(expectedAB, adjAvg, 2);
    const floor = binomAtLeast(expectedAB - 1, adjAvg * 0.85, 2);
    const ceiling = binomAtLeast(expectedAB + 1, adjAvg * 1.15, 2);
    out.push({
      market: "hit_2", confidence: toConfidence(p, 0.25, 180), projection: p,
      floor, ceiling, trigger, triggerStrength,
      features: baseFeatures(ctx, { avg, adjAvg, expectedAB }),
      dataQuality: dqBase, recommended: false, recScore: 0,
    });
  }
  // home_run
  {
    // Our own independent HR probability, from this hitter's blended HR rate,
    // matchup-adjusted and scaled to expected plate appearances. No Vegas input.
    const p = 1 - Math.pow(1 - adjHR, ctx.expectedPA);
    const parkFactor = ctx.parkFactor ?? 100;
    const leagueHrPerPa = 0.032;
    const parkHrPerPa = leagueHrPerPa * (parkFactor / 100);
    // Park-neutral baseline (any average hitter, this park, these PAs) — used
    // only as a display comparison, never as a recommendation input.
    const parkHrProb = 1 - Math.pow(1 - parkHrPerPa, ctx.expectedPA);
    // Vegas is optional and informational only (display comparison). It is
    // NEVER used to compute confidence or the recommendation below.
    const vegasHrProb = ctx.vegasHrProb ?? null;
    const liftVsPark = parkHrProb > 0 ? (p - parkHrProb) / parkHrProb : 0;

    let verdict, verdictNote;
    if (vegasHrProb != null) {
      const hi = Math.max(parkHrProb, vegasHrProb);
      const lo = Math.min(parkHrProb, vegasHrProb);
      verdict = p > hi + 0.005 ? "strong" : p >= lo - 0.005 ? "middling" : "fade";
      verdictNote = `Ours ${(p * 100).toFixed(1)}% vs Park ${(parkHrProb * 100).toFixed(1)}% vs Vegas ${(vegasHrProb * 100).toFixed(1)}%. Shown for comparison only — not used in the recommendation.`;
    } else {
      verdict = p > parkHrProb + 0.005 ? "strong" : p >= parkHrProb - 0.005 ? "middling" : "fade";
      verdictNote = `Ours ${(p * 100).toFixed(1)}% vs park-neutral baseline ${(parkHrProb * 100).toFixed(1)}% (no odds provider connected). Shown for comparison only — not used in the recommendation.`;
    }

    out.push({
      market: "home_run", confidence: toConfidence(p, 0.10, 300), projection: p,
      floor: p * 0.6, ceiling: Math.min(1, p * 1.5),
      trigger, triggerStrength,
      features: { ...baseFeatures(ctx, { hrRate, adjHR, parkFactor, liftVsPark }), verdict, verdictNote, parkHrProb, vegasHrProb },
      dataQuality: dqBase, recommended: false, recScore: 0,
      verdict, verdictNote,
    });
  }
  // total_bases
  {
    const tbPerPA = ctx.season && ctx.season.pa > 0
      ? (ctx.season.hits + ctx.season.doubles + ctx.season.triples * 2 + ctx.season.home_runs * 3) / ctx.season.pa : slg;
    const adjTB = tbPerPA * matchupMult;
    const proj = adjTB * ctx.expectedPA;
    out.push({
      market: "total_bases", confidence: toConfidence(proj / 3, 0.5, 100), projection: proj,
      floor: proj * 0.7, ceiling: proj * 1.4,
      trigger, triggerStrength,
      features: baseFeatures(ctx, { slg, adjSlg, tbPerPA }),
      dataQuality: dqBase, recommended: false, recScore: 0,
    });
  }
  // hrr
  {
    const proj = adjHrr * ctx.expectedPA;
    out.push({
      market: "hrr", confidence: toConfidence(proj / 3, 0.5, 100), projection: proj,
      floor: proj * 0.65, ceiling: proj * 1.45,
      trigger, triggerStrength,
      features: baseFeatures(ctx, { hrrRate, adjHrr }),
      dataQuality: dqBase, recommended: false, recScore: 0,
    });
  }

  // Recommendation logic. HR recommendations are built from the full feature
  // set (confidence, trigger/matchup, park-adjusted lift, floor/ceiling
  // spread, lineup slot) — the verdict label is display-only, never a driver.
  for (const s of out) {
    if (s.market === "home_run") {
      const liftVsPark = s.features?.liftVsPark ?? 0;
      const lineupWeight = ctx.battingOrder && ctx.battingOrder <= 6 ? 1 : 0.7;
      const spread = Math.max(0, s.ceiling - s.floor);
      let recScore =
        s.confidence * 0.45 +
        Math.max(0, s.triggerStrength) * 20 +
        Math.max(0, Math.min(liftVsPark, 1)) * 20 * lineupWeight +
        Math.min(spread * 10, 10);
      s.recScore = Math.min(100, Math.max(0, recScore));
      s.recommended = s.recScore >= 55 && s.dataQuality !== "missing";
    } else {
      let recScore = s.confidence * 0.4 + Math.max(0, s.triggerStrength) * 30 + (s.floor > 0.5 ? 15 : 0);
      s.recScore = Math.min(100, recScore);
      s.recommended = s.recScore >= 55 && s.dataQuality !== "missing";
    }
  }
  return out;
}

export function scorePitcher(name, ctx) {
  const out = [];
  const st = ctx.season;
  if (!st) return out;
  const dq = st.quality === "partial" ? "partial" : "ok";

  const leagueK = 0.225;
  const oppK = ctx.oppTeamK ?? leagueK;
  const matchupK = 1 + (oppK - leagueK) * 1.5;
  const kPer9 = st.k_per_9 * matchupK;
  const projK = (kPer9 / 9) * ctx.expectedIP;

  const triggers = [];
  if (oppK > leagueK + 0.02) triggers.push(`high-K offense (${(oppK * 100).toFixed(1)}%)`);
  if (oppK < leagueK - 0.02) triggers.push(`low-K offense (${(oppK * 100).toFixed(1)}%)`);
  const trigger = triggers[0] ?? `${kPer9.toFixed(1)} K/9 adjusted`;
  const triggerStrength = Math.max(-1, Math.min(1, (matchupK - 1) * 3));

  out.push({
    market: "strikeouts", confidence: toConfidence(projK / 9, 0.6, 80), projection: projK,
    floor: projK * 0.7, ceiling: projK * 1.35,
    trigger, triggerStrength,
    features: { kPer9: st.k_per_9, adjustedKPer9: kPer9, oppTeamK: oppK, expectedIP: ctx.expectedIP, era: st.era, whip: st.whip },
    dataQuality: dq, recommended: false, recScore: 0,
  });

  for (const s of out) {
    let recScore = s.confidence * 0.5 + Math.max(0, s.triggerStrength) * 25 + (s.projection >= 5.5 ? 15 : 0);
    s.recScore = Math.min(100, recScore);
    s.recommended = s.recScore >= 50 && s.dataQuality !== "missing";
  }
  return out;
}

export { expectedPAForBattingOrder };