// Probability-model scoring for MLB player props

export const MARKET_LABELS = {
  hit_2: "2+ Hits",
  hrr_2: "Hits+Runs+RBIs 2.5",
  hrr_3: "Hits+Runs+RBIs 3.5",
  total_bases: "Total Bases 2.5",
  home_run: "Home Run",
  strikeouts: "Strikeouts 6.5",
};

export const MARKET_PROJECTION_UNIT = {
  hit_2: { unit: "probability", label: "P(2+ hits)", description: "Probability the hitter records 2 or more hits." },
  home_run: { unit: "probability", label: "P(HR)", description: "Probability the hitter hits at least 1 home run." },
  total_bases: { unit: "count", label: "Exp. total bases", description: "Expected total bases (1B=1, 2B=2, 3B=3, HR=4). Line = 2.5." },
  hrr_2: { unit: "count", label: "Exp. H+R+RBI", description: "Expected Hits + Runs + RBIs combined. Line = 2.5." },
  hrr_3: { unit: "count", label: "Exp. H+R+RBI", description: "Expected Hits + Runs + RBIs combined. Line = 3.5." },
  strikeouts: { unit: "count", label: "Exp. K", description: "Expected strikeouts for the starting pitcher. Line = 6.5." },
};

const LEAGUE = {
  hitPerAB: 0.245,
  hrPerPA: 0.032,
  tbPerPA: 0.43,
  hrrPerPA: 0.37,
  kRate: 0.225,
  pitcherHrPerBF: 0.032,
};

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

function blend(season, recent, wRecent = 0.35) {
  if (season == null && recent == null) return null;
  if (season == null) return recent;
  if (recent == null) return season;
  return season * (1 - wRecent) + recent * wRecent;
}

function toConfidence(prob, anchor = 0.5, slope = 130) {
  const c = 50 + slope * (prob - anchor);
  return clamp(c, 0, 100);
}

function empiricalBayesRate(successes, trials, priorMean, priorStrength) {
  const s = Number(successes ?? 0);
  const n = Number(trials ?? 0);
  const alpha = priorMean * priorStrength;
  const beta = (1 - priorMean) * priorStrength;
  if (n <= 0) return priorMean;
  return (s + alpha) / (n + alpha + beta);
}

function binomAtLeast(n, p, k) {
  if (n <= 0) return 0;
  const pp = clamp(p, 1e-6, 1 - 1e-6);
  let logC = 0;
  const logP = Math.log(pp);
  const log1p = Math.log(1 - pp);
  let cum = 0;
  for (let i = 0; i <= n; i++) {
    if (i === 0) {
      cum += Math.exp(n * log1p);
    } else {
      logC += Math.log((n - i + 1) / i);
      cum += Math.exp(logC + i * logP + (n - i) * log1p);
    }
    if (i + 1 === k) return clamp(1 - cum, 0, 1);
  }
  return 0;
}

function poissonAtLeast(lambda, k) {
  const l = Math.max(0, lambda);
  if (k <= 0) return 1;
  if (l === 0) return 0;
  let term = Math.exp(-l);
  let cum = term;
  for (let i = 1; i < k; i++) {
    term = (term * l) / i;
    cum += term;
  }
  return clamp(1 - cum, 0, 1);
}

function baseFeatures(ctx, extras = {}) {
  return {
    expectedPA: ctx.expectedPA,
    battingOrder: ctx.battingOrder ?? null,
    oppPitcherK: ctx.oppPitcherK ?? null,
    oppPitcherHrPerBF: ctx.oppPitcherHrPerBF ?? null,
    parkFactor: ctx.parkFactor ?? 100,
    ...extras,
  };
}

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
  const dqBase = !ctx.season && !ctx.recent
    ? "missing"
    : ctx.season?.quality === "partial" || ctx.recent?.quality === "partial" || !ctx.season || !ctx.recent
      ? "partial"
      : "ok";

  const seasonPA = ctx.season?.pa ?? 0;
  const recentPA = ctx.recent?.pa ?? 0;
  const seasonAB = ctx.season?.ab ?? 0;
  const recentAB = ctx.recent?.ab ?? 0;

  const hitPerABSeason = empiricalBayesRate(ctx.season?.hits ?? 0, seasonAB, LEAGUE.hitPerAB, 120);
  const hitPerABRecent = recentAB > 0
    ? empiricalBayesRate(ctx.recent?.hits ?? 0, recentAB, hitPerABSeason, 45)
    : null;
  const hitPerAB = blend(hitPerABSeason, hitPerABRecent, recentPA >= 30 ? 0.45 : 0.25) ?? LEAGUE.hitPerAB;

  const hrPerPASeason = empiricalBayesRate(ctx.season?.home_runs ?? 0, seasonPA, LEAGUE.hrPerPA, 220);
  const hrPerPARecent = recentPA > 0
    ? empiricalBayesRate(ctx.recent?.home_runs ?? 0, recentPA, hrPerPASeason, 70)
    : null;
  const hrPerPA = blend(hrPerPASeason, hrPerPARecent, recentPA >= 35 ? 0.4 : 0.2) ?? LEAGUE.hrPerPA;

  const seasonTB = (ctx.season?.hits ?? 0) + (ctx.season?.doubles ?? 0) + (ctx.season?.triples ?? 0) * 2 + (ctx.season?.home_runs ?? 0) * 3;
  const recentTB = (ctx.recent?.hits ?? 0) + (ctx.recent?.doubles ?? 0) + (ctx.recent?.triples ?? 0) * 2 + (ctx.recent?.home_runs ?? 0) * 3;
  const tbPerPASeason = empiricalBayesRate(seasonTB, seasonPA, LEAGUE.tbPerPA, 140);
  const tbPerPARecent = recentPA > 0
    ? empiricalBayesRate(recentTB, recentPA, tbPerPASeason, 45)
    : null;
  const tbPerPA = blend(tbPerPASeason, tbPerPARecent, recentPA >= 35 ? 0.4 : 0.2) ?? LEAGUE.tbPerPA;

  const seasonHRR = (ctx.season?.hits ?? 0) + (ctx.season?.runs ?? 0) + (ctx.season?.rbi ?? 0);
  const recentHRR = (ctx.recent?.hits ?? 0) + (ctx.recent?.runs ?? 0) + (ctx.recent?.rbi ?? 0);
  const hrrPerPASeason = empiricalBayesRate(seasonHRR, seasonPA, LEAGUE.hrrPerPA, 140);
  const hrrPerPARecent = recentPA > 0
    ? empiricalBayesRate(recentHRR, recentPA, hrrPerPASeason, 45)
    : null;
  const hrrPerPA = blend(hrrPerPASeason, hrrPerPARecent, recentPA >= 35 ? 0.4 : 0.2) ?? LEAGUE.hrrPerPA;

  const expectedPA = Math.max(3.0, ctx.expectedPA ?? expectedPAForBattingOrder(ctx.battingOrder));
  const expectedAB = Math.max(2, Math.round(expectedPA * 0.87));
  const oppK = ctx.oppPitcherK ?? LEAGUE.kRate;
  const contactMult = clamp(1 + (LEAGUE.kRate - oppK) * 0.9, 0.85, 1.15);

  const oppPitcherHrPerBF = ctx.oppPitcherHrPerBF ?? LEAGUE.pitcherHrPerBF;
  const pitcherHrMult = clamp(oppPitcherHrPerBF / LEAGUE.pitcherHrPerBF, 0.75, 1.35);
  const parkFactor = ctx.parkFactor ?? 100;
  const parkHrMult = clamp(parkFactor / 100, 0.8, 1.25);
  const recentHrDelta = hrPerPARecent != null ? clamp((hrPerPARecent - hrPerPASeason) * 8, -0.18, 0.18) : 0;
  const hrFormMult = 1 + recentHrDelta;

  const hitRateAdj = clamp(hitPerAB * contactMult, 0.12, 0.45);
  const hrPerPAAdj = clamp(hrPerPA * pitcherHrMult * parkHrMult * hrFormMult, 0.004, 0.16);
  const tbPerPAAdj = clamp(tbPerPA * contactMult * clamp(1 + (parkFactor - 100) / 100 * 0.15, 0.9, 1.1), 0.18, 0.95);
  const hrrPerPAAdj = clamp(hrrPerPA * contactMult, 0.18, 0.95);

  const triggers = [];
  if (hrPerPARecent != null && hrPerPARecent > hrPerPASeason + 0.012) triggers.push("HR form up");
  if (hrPerPARecent != null && hrPerPARecent < hrPerPASeason - 0.012) triggers.push("HR form down");
  if (oppK < LEAGUE.kRate - 0.02) triggers.push(`contact matchup (${(oppK * 100).toFixed(1)}% K)`);
  if (oppPitcherHrPerBF > LEAGUE.pitcherHrPerBF + 0.004) triggers.push("HR-prone pitcher");
  const trigger = triggers[0] ?? `EB rates: HR ${(hrPerPAAdj * 100).toFixed(1)}%/PA, Hit ${(hitRateAdj * 100).toFixed(1)}%/AB`;
  const triggerStrength = clamp((contactMult - 1) * 1.7 + (pitcherHrMult - 1) * 1.4 + recentHrDelta * 2.4, -1, 1);

  {
    const p = binomAtLeast(expectedAB, hitRateAdj, 2);
    const floor = binomAtLeast(Math.max(1, expectedAB - 1), clamp(hitRateAdj * 0.9, 0.08, 0.5), 2);
    const ceiling = binomAtLeast(expectedAB + 1, clamp(hitRateAdj * 1.1, 0.08, 0.55), 2);
    out.push({
      market: "hit_2",
      confidence: toConfidence(p, 0.27, 170),
      projection: p,
      floor,
      ceiling,
      trigger,
      triggerStrength,
      features: baseFeatures(ctx, { hitPerAB, hitRateAdj, expectedAB, pOverLine: p }),
      dataQuality: dqBase,
      recommended: false,
      recScore: 0,
    });
  }

  {
    const p = 1 - Math.pow(1 - hrPerPAAdj, expectedPA);
    const parkHrPerPA = LEAGUE.hrPerPA * (parkFactor / 100);
    const parkHrProb = 1 - Math.pow(1 - parkHrPerPA, expectedPA);
    const vegasHrProb = ctx.vegasHrProb ?? null;
    const liftVsPark = parkHrProb > 0 ? (p - parkHrProb) / parkHrProb : 0;

    const nEff = Math.max(60, seasonPA + recentPA * 0.8);
    const std = Math.sqrt((p * (1 - p)) / nEff);
    const floor = clamp(p - 1.15 * std, 0, 1);
    const ceiling = clamp(p + 1.15 * std, 0, 1);

    let verdict;
    let verdictNote;
    if (vegasHrProb != null) {
      const hi = Math.max(parkHrProb, vegasHrProb);
      const lo = Math.min(parkHrProb, vegasHrProb);
      verdict = p > hi + 0.006 ? "strong" : p >= lo - 0.006 ? "middling" : "fade";
      verdictNote = `Ours ${(p * 100).toFixed(1)}% vs Park ${(parkHrProb * 100).toFixed(1)}% vs Vegas ${(vegasHrProb * 100).toFixed(1)}%.`;
    } else {
      verdict = p > parkHrProb + 0.006 ? "strong" : p >= parkHrProb - 0.006 ? "middling" : "fade";
      verdictNote = `Ours ${(p * 100).toFixed(1)}% vs park baseline ${(parkHrProb * 100).toFixed(1)}% (no Vegas).`;
    }

    out.push({
      market: "home_run",
      confidence: toConfidence(p, 0.1, 300),
      projection: p,
      floor,
      ceiling,
      trigger,
      triggerStrength,
      features: {
        ...baseFeatures(ctx, {
          hrPerPA,
          hrPerPAAdj,
          pitcherHrMult,
          parkHrMult,
          hrFormMult,
          liftVsPark,
          parkHrProb,
          vegasHrProb,
        }),
        verdict,
        verdictNote,
        pOverLine: p,
      },
      dataQuality: dqBase,
      recommended: false,
      recScore: 0,
      verdict,
      verdictNote,
    });
  }

  {
    const lambda = tbPerPAAdj * expectedPA;
    const pOver = poissonAtLeast(lambda, 2);
    out.push({
      market: "total_bases",
      confidence: toConfidence(pOver, 0.35, 150),
      projection: lambda,
      floor: lambda * 0.72,
      ceiling: lambda * 1.28,
      trigger,
      triggerStrength,
      features: baseFeatures(ctx, { tbPerPA, tbPerPAAdj, pOverLine: pOver }),
      dataQuality: dqBase,
      recommended: false,
      recScore: 0,
    });
  }

  {
    const lambda = hrrPerPAAdj * expectedPA;
    const pOver2 = poissonAtLeast(lambda, 3);
    out.push({
      market: "hrr_2",
      confidence: toConfidence(pOver2, 0.35, 150),
      projection: lambda,
      floor: lambda * 0.7,
      ceiling: lambda * 1.3,
      trigger,
      triggerStrength,
      features: baseFeatures(ctx, { hrrPerPA, hrrPerPAAdj, pOverLine: pOver2 }),
      dataQuality: dqBase,
      recommended: false,
      recScore: 0,
    });
    const pOver3 = poissonAtLeast(lambda, 4);
    out.push({
      market: "hrr_3",
      confidence: toConfidence(pOver3, 0.12, 200),
      projection: lambda,
      floor: lambda * 0.7,
      ceiling: lambda * 1.3,
      trigger,
      triggerStrength,
      features: baseFeatures(ctx, { hrrPerPA, hrrPerPAAdj, pOverLine: pOver3 }),
      dataQuality: dqBase,
      recommended: false,
      recScore: 0,
    });
  }

  for (const s of out) {
    const pOver = s.features?.pOverLine ?? (s.market === "hit_2" || s.market === "home_run" ? s.projection : 0.5);
    if (s.market === "home_run") {
      const liftVsPark = s.features?.liftVsPark ?? 0;
      const certainty = Math.max(0, 1 - (s.ceiling - s.floor) * 3.5);
      // STRONG verdict = model beats both park and Vegas baselines → meaningful edge signal
      // MIDDLING verdict = model sits between baselines → potential hidden edge
      const verdictBonus = s.verdict === "strong" ? 8 : s.verdict === "middling" ? 4 : 0;
      const recScore =
        s.confidence * 0.42 +
        pOver * 34 +
        Math.max(0, liftVsPark) * 110 +
        Math.max(0, s.triggerStrength) * 14 +
        certainty * 10 +
        verdictBonus;
      s.recScore = clamp(recScore, 0, 100);
      s.recommended = s.recScore >= 52 && s.dataQuality !== "missing";
    } else {
      const recScore =
        s.confidence * 0.5 +
        pOver * 30 +
        Math.max(0, s.triggerStrength) * 18;
      s.recScore = clamp(recScore, 0, 100);
      s.recommended = s.recScore >= 50 && s.dataQuality !== "missing";
    }
  }

  return out;
}

export function scorePitcher(name, ctx) {
  const st = ctx.season;
  if (!st) return [];

  const dq = st.quality === "partial" ? "partial" : "ok";
  const leagueK = LEAGUE.kRate;
  const oppK = ctx.oppTeamK ?? leagueK;

  const kRateSeason = empiricalBayesRate(st.so ?? 0, st.bf ?? 0, leagueK, 220);
  const matchupMult = clamp(1 + (oppK - leagueK) * 0.9, 0.82, 1.2);
  const kRateAdj = clamp(kRateSeason * matchupMult, 0.12, 0.45);

  const expectedIP = ctx.expectedIP ?? clamp((st.gs ?? 0) > 0 ? (st.ip ?? 0) / (st.gs ?? 1) : 5.5, 4.5, 7.0);
  const expectedBF = expectedIP * 4.2;
  const lambdaK = expectedBF * kRateAdj;
  const pOver = poissonAtLeast(lambdaK, 7);

  const trigger =
    oppK > leagueK + 0.02
      ? `high-K offense (${(oppK * 100).toFixed(1)}%)`
      : oppK < leagueK - 0.02
        ? `low-K offense (${(oppK * 100).toFixed(1)}%)`
        : `K model ${(lambdaK).toFixed(2)} vs line 6.5`;
  const triggerStrength = clamp((matchupMult - 1) * 2.2, -1, 1);

  const pick = {
    market: "strikeouts",
    confidence: toConfidence(pOver, 0.35, 170),
    projection: lambdaK,
    floor: lambdaK * 0.72,
    ceiling: lambdaK * 1.28,
    trigger,
    triggerStrength,
    features: {
      kRateSeason,
      kRateAdj,
      oppTeamK: oppK,
      expectedIP,
      expectedBF,
      pOverLine: pOver,
      era: st.era,
      whip: st.whip,
    },
    dataQuality: dq,
    recommended: false,
    recScore: 0,
  };

  pick.recScore = clamp(
    pick.confidence * 0.52 +
      pOver * 32 +
      Math.max(0, pick.triggerStrength) * 12,
    0,
    100
  );
  pick.recommended = pick.recScore >= 55 && pick.dataQuality !== "missing";

  return [pick];
}

export { expectedPAForBattingOrder };