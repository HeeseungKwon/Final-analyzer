// Legacy deterministic scoring retained for one-off A/B comparison.

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

export function scoreHitterLegacy(name, ctx) {
  const out = [];
  const dqBase = !ctx.season && !ctx.recent
    ? "missing"
    : ctx.season?.quality === "partial" || ctx.recent?.quality === "partial" || !ctx.season || !ctx.recent
      ? "partial"
      : "ok";

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
  {
    const p = 1 - Math.pow(1 - adjHR, ctx.expectedPA);
    const parkFactor = ctx.parkFactor ?? 100;
    const leagueHrPerPa = 0.032;
    const parkHrPerPa = leagueHrPerPa * (parkFactor / 100);
    const parkHrProb = 1 - Math.pow(1 - parkHrPerPa, ctx.expectedPA);
    const vegasHrProb = ctx.vegasHrProb ?? null;
    const liftVsPark = parkHrProb > 0 ? (p - parkHrProb) / parkHrProb : 0;

    let verdict, verdictNote;
    if (vegasHrProb != null) {
      const hi = Math.max(parkHrProb, vegasHrProb);
      const lo = Math.min(parkHrProb, vegasHrProb);
      verdict = p > hi + 0.005 ? "strong" : p >= lo - 0.005 ? "middling" : "fade";
      verdictNote = `Ours ${(p * 100).toFixed(1)}% vs Park ${(parkHrProb * 100).toFixed(1)}% vs Vegas ${(vegasHrProb * 100).toFixed(1)}%.`;
    } else {
      verdict = p > parkHrProb + 0.005 ? "strong" : p >= parkHrProb - 0.005 ? "middling" : "fade";
      verdictNote = `Ours ${(p * 100).toFixed(1)}% vs park baseline ${(parkHrProb * 100).toFixed(1)}% (no odds provider).`;
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

  for (const s of out) {
    if (s.market === "home_run") {
      const liftVsPark = s.features?.liftVsPark ?? 0;
      const lineupWeight = ctx.battingOrder && ctx.battingOrder <= 6 ? 1 : 0.7;
      const spread = Math.max(0, s.ceiling - s.floor);
      const recScore =
        s.confidence * 0.45 +
        Math.max(0, s.triggerStrength) * 20 +
        Math.max(0, Math.min(liftVsPark, 1)) * 20 * lineupWeight +
        Math.min(spread * 10, 10);
      s.recScore = Math.min(100, Math.max(0, recScore));
      s.recommended = s.recScore >= 55 && s.dataQuality !== "missing";
    } else {
      const recScore = s.confidence * 0.4 + Math.max(0, s.triggerStrength) * 30 + (s.floor > 0.5 ? 15 : 0);
      s.recScore = Math.min(100, recScore);
      s.recommended = s.recScore >= 55 && s.dataQuality !== "missing";
    }
  }
  return out;
}

export function scorePitcherLegacy(name, ctx) {
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
    const recScore = s.confidence * 0.5 + Math.max(0, s.triggerStrength) * 25 + (s.projection >= 5.5 ? 15 : 0);
    s.recScore = Math.min(100, recScore);
    s.recommended = s.recScore >= 50 && s.dataQuality !== "missing";
  }
  return out;
}
