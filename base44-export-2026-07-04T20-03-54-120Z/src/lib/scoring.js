// Probability-model scoring for MLB player props

export const MARKET_LABELS = {
  hit_2: "2+ Hits",
  hrr_2: "HRR O1.5",
  hrr_3: "HRR O2.5",
  total_bases: "TB O1.5",
  home_run: "Home Run",
  strikeouts: "Strikeouts 6.5",
};

export const MARKET_PROJECTION_UNIT = {
  hit_2: { unit: "probability", label: "P(2+ hits)", description: "Probability the hitter records 2 or more hits." },
  home_run: { unit: "probability", label: "P(HR)", description: "Probability the hitter hits at least 1 home run." },
  total_bases: { unit: "probability", label: "P(TB ≥ 2)", description: "Probability total bases reach at least 2 for the TB O1.5 line." },
  hrr_2: { unit: "probability", label: "P(HRR ≥ 2)", description: "Probability hits + runs + RBIs reach at least 2 for the HRR O1.5 line." },
  hrr_3: { unit: "probability", label: "P(HRR ≥ 3)", description: "Probability hits + runs + RBIs reach at least 3 for the HRR O2.5 line." },
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

const MARKET_IMPLIED_BASELINE = {
  hit_2: 0.33,
  total_bases: 0.53,
  hrr_2: 0.56,
  hrr_3: 0.34,
  home_run: 0.14,
  strikeouts: 0.46,
};

const FRAMEWORK_PROBABILITY_MARKETS = new Set([
  "hit_1",
  ...Object.entries(MARKET_PROJECTION_UNIT)
    .filter(([, config]) => config.unit === "probability")
    .map(([marketKey]) => marketKey),
]);

const ATC_LIKE_WEIGHTS = {
  hit_1: { zips: 0.29, steamer: 0.33, batx: 0.23, pecota: 0.15 },
  hit_2: { zips: 0.28, steamer: 0.34, batx: 0.21, pecota: 0.17 },
  home_run: { zips: 0.2, steamer: 0.27, batx: 0.39, pecota: 0.14 },
  total_bases: { zips: 0.24, steamer: 0.23, batx: 0.37, pecota: 0.16 },
  hrr_2: { zips: 0.25, steamer: 0.24, batx: 0.33, pecota: 0.18 },
  hrr_3: { zips: 0.24, steamer: 0.24, batx: 0.32, pecota: 0.2 },
  strikeouts: { zips: 0.23, steamer: 0.36, batx: 0.21, pecota: 0.2 },
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

function hashSeed(input) {
  let h = 2166136261;
  const str = String(input ?? "");
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) || 1;
}

function makeRng(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6D2B79F5;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function normalFromRng(rng) {
  const u1 = Math.max(1e-9, rng());
  const u2 = Math.max(1e-9, rng());
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function poissonSample(lambda, rng) {
  const l = Math.max(0, lambda);
  if (l <= 0) return 0;
  if (l > 18) {
    return Math.max(0, Math.round(l + Math.sqrt(l) * normalFromRng(rng)));
  }
  const threshold = Math.exp(-l);
  let p = 1;
  let k = 0;
  while (p > threshold && k < 40) {
    p *= rng();
    k += 1;
  }
  return Math.max(0, k - 1);
}

function impliedMarketProb(market, features = {}) {
  if (market === "home_run" && Number.isFinite(features.vegasHrProb)) {
    return clamp(features.vegasHrProb, 0.02, 0.7);
  }
  return MARKET_IMPLIED_BASELINE[market] ?? 0.5;
}

function variancePenalty(floor, ceiling) {
  const spread = Math.max(0, Number(ceiling ?? 0) - Number(floor ?? 0));
  return clamp(spread / 0.35, 0, 1);
}

function confidenceFromSignals({
  market,
  prob,
  floor,
  ceiling,
  impliedProb,
  agreement,
  edge,
  historicalReliability,
  matchupQuality,
  lineupQuality,
  recentForm,
}) {
  const modelConfidence = toConfidence(prob, impliedProb, market === "home_run" ? 260 : 155);
  const score =
    modelConfidence * 0.33 +
    clamp(edge * 100, -12, 18) * 1.55 +
    agreement * 13 +
    historicalReliability * 11 +
    matchupQuality * 9 +
    lineupQuality * 7 +
    recentForm * 7 -
    variancePenalty(floor, ceiling) * 14;
  return clamp(score, 0, 100);
}

function simulateHitterMarkets({
  name,
  expectedAB,
  expectedPA,
  hitRateAdj,
  hrPerPAAdj,
  tbPerPAAdj,
  hrrPerPAAdj,
}) {
  const rng = makeRng(hashSeed(`${name}:${expectedAB}:${expectedPA}:${hitRateAdj.toFixed(4)}:${hrrPerPAAdj.toFixed(4)}`));
  const trials = 900;
  let hit2 = 0;
  let tb2 = 0;
  let hrr2 = 0;
  let hrr3 = 0;
  let hr1 = 0;
  const hrrSamples = [];

  for (let i = 0; i < trials; i++) {
    const gameFactor = normalFromRng(rng);
    const hitP = clamp(hitRateAdj * (1 + gameFactor * 0.16), 0.06, 0.7);
    const hrP = clamp(hrPerPAAdj * (1 + gameFactor * 0.22), 0.001, 0.5);
    const hrrRate = clamp(hrrPerPAAdj * (1 + gameFactor * 0.12), 0.05, 1.7);
    const tbRate = clamp(tbPerPAAdj * (1 + gameFactor * 0.11), 0.05, 1.6);

    let hits = 0;
    for (let ab = 0; ab < expectedAB; ab++) {
      if (rng() < hitP) hits += 1;
    }

    let hr = 0;
    for (let pa = 0; pa < expectedPA; pa++) {
      if (rng() < hrP) hr += 1;
    }

    const tbExtra = poissonSample(Math.max(0, tbRate * expectedPA - hits), rng);
    const totalBases = hits + tbExtra + hr;
    const runsRbi = poissonSample(Math.max(0.1, hrrRate * expectedPA - hits), rng);
    const hrr = hits + runsRbi;
    hrrSamples.push(hrr);

    if (hits >= 2) hit2 += 1;
    if (totalBases >= 2) tb2 += 1;
    if (hrr >= 2) hrr2 += 1;
    if (hrr >= 3) hrr3 += 1;
    if (hr >= 1) hr1 += 1;
  }

  hrrSamples.sort((a, b) => a - b);
  const p10 = hrrSamples[Math.floor(trials * 0.1)] ?? 0;
  const p90 = hrrSamples[Math.floor(trials * 0.9)] ?? 0;

  return {
    hit_2: hit2 / trials,
    total_bases: tb2 / trials,
    hrr_2: hrr2 / trials,
    hrr_3: hrr3 / trials,
    home_run: hr1 / trials,
    hrrSpread: clamp((p90 - p10) / 6, 0, 1),
  };
}

function enforceHitterCoherence(out) {
  const byMarket = new Map(out.map((row) => [row.market, row]));
  const hit2 = byMarket.get("hit_2");
  const tb2 = byMarket.get("total_bases");
  const hrr2 = byMarket.get("hrr_2");
  const hrr3 = byMarket.get("hrr_3");

  if (hit2 && tb2) {
    const minTb = clamp(hit2.projection + 0.01, hit2.projection, 0.995);
    tb2.projection = Math.max(tb2.projection, minTb);
    tb2.floor = Math.max(tb2.floor, hit2.floor);
    tb2.ceiling = Math.max(tb2.ceiling, tb2.projection);
  }

  if (hit2 && hrr2) {
    const minHrr2 = clamp(hit2.projection + 0.025, hit2.projection, 0.995);
    hrr2.projection = Math.max(hrr2.projection, minHrr2);
    hrr2.floor = Math.max(hrr2.floor, hit2.floor);
    hrr2.ceiling = Math.max(hrr2.ceiling, hrr2.projection);
  }

  if (hrr2 && hrr3) {
    hrr3.projection = Math.min(hrr3.projection, Math.max(0.01, hrr2.projection - 0.02));
    hrr3.floor = Math.min(hrr3.floor, hrr3.projection);
    hrr3.ceiling = Math.min(hrr3.ceiling, hrr2.ceiling);
  }
}

function empiricalBayesRate(successes, trials, priorMean, priorStrength) {
  const s = Number(successes ?? 0);
  const n = Number(trials ?? 0);
  const alpha = priorMean * priorStrength;
  const beta = (1 - priorMean) * priorStrength;
  if (n <= 0) return priorMean;
  return (s + alpha) / (n + alpha + beta);
}

function clampProjection(market, value) {
  if (FRAMEWORK_PROBABILITY_MARKETS.has(market)) return clamp(value, 0, 1);
  return clamp(value, 0, 15);
}

function modelAgreement(market, values) {
  const nums = values.filter((v) => Number.isFinite(v));
  if (nums.length < 2) return 0.5;
  const spread = Math.max(...nums) - Math.min(...nums);
  const scale = FRAMEWORK_PROBABILITY_MARKETS.has(market) ? 0.22 : 2.4;
  return clamp(1 - spread / scale, 0, 1);
}

function expectedCountRange(lambda, floorMult, ceilingMult, line) {
  const expectedCount = Math.max(0, lambda);
  const floorCount = expectedCount * floorMult;
  const ceilingCount = expectedCount * ceilingMult;
  return {
    expectedCount,
    floorCount,
    ceilingCount,
    floorProb: poissonAtLeast(floorCount, line),
    ceilingProb: poissonAtLeast(ceilingCount, line),
  };
}

function frameworkBlend({
  market,
  baseProjection,
  leagueBaseline,
  skillProjection,
  recentProjection,
  contextProjection,
  floor,
  ceiling,
}) {
  const base = Number.isFinite(baseProjection) ? baseProjection : leagueBaseline;
  const skill = Number.isFinite(skillProjection) ? skillProjection : base;
  const recent = Number.isFinite(recentProjection) ? recentProjection : skill;
  const context = Number.isFinite(contextProjection) ? contextProjection : base;
  const center = Number.isFinite((floor + ceiling) / 2) ? (floor + ceiling) / 2 : base;

  const zipsLike = clampProjection(market, skill * 0.74 + recent * 0.26);
  const steamerLike = clampProjection(market, skill * 0.64 + leagueBaseline * 0.36);
  const batxLike = clampProjection(market, base * 0.58 + context * 0.42);
  const pecotaLike = clampProjection(market, base * 0.62 + center * 0.38);

  const w = ATC_LIKE_WEIGHTS[market] ?? { zips: 0.25, steamer: 0.25, batx: 0.25, pecota: 0.25 };
  const atcLike = clampProjection(
    market,
    zipsLike * w.zips + steamerLike * w.steamer + batxLike * w.batx + pecotaLike * w.pecota
  );

  const agreement = modelAgreement(market, [zipsLike, steamerLike, batxLike, pecotaLike]);

  return {
    projection: atcLike,
    agreement,
    components: {
      zipsLike,
      steamerLike,
      batxLike,
      pecotaLike,
      atcLike,
    },
  };
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

// Practical MLB projection pipeline:
// 1) weight recent performance into skill components,
// 2) regress volatile samples toward league baselines,
// 3) apply matchup/park context multipliers when inputs exist,
// 4) convert the final rate projection into benchmark probabilities.
// When optional context inputs are missing, the model gracefully falls back
// to the regressed season + recent baseline instead of dropping the market.
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
  const sim = simulateHitterMarkets({
    name,
    expectedAB,
    expectedPA,
    hitRateAdj,
    hrPerPAAdj,
    tbPerPAAdj,
    hrrPerPAAdj,
  });

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
    const leagueBaseline = binomAtLeast(expectedAB, LEAGUE.hitPerAB, 2);
    const seasonProjection = binomAtLeast(expectedAB, hitPerABSeason, 2);
    const recentProjection = hitPerABRecent != null ? binomAtLeast(expectedAB, hitPerABRecent, 2) : seasonProjection;
    const contextProjection = binomAtLeast(expectedAB, clamp(hitPerAB * contactMult, 0.1, 0.5), 2);
    const ensemble = frameworkBlend({
      market: "hit_2",
      baseProjection: p,
      leagueBaseline,
      skillProjection: seasonProjection,
      recentProjection,
      contextProjection,
      floor,
      ceiling,
    });
    const pFinal = clamp(ensemble.projection * 0.68 + sim.hit_2 * 0.32, 0, 1);
    out.push({
      market: "hit_2",
      confidence: toConfidence(pFinal, 0.27, 170),
      projection: pFinal,
      floor,
      ceiling,
      trigger,
      triggerStrength,
      features: baseFeatures(ctx, {
        hitPerAB,
        hitRateAdj,
        expectedAB,
        pOverLine: pFinal,
        modelAgreement: ensemble.agreement,
        framework: ensemble.components,
        monteCarloProb: sim.hit_2,
      }),
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
    const leagueBaseline = 1 - Math.pow(1 - LEAGUE.hrPerPA, expectedPA);
    const seasonProjection = 1 - Math.pow(1 - hrPerPASeason, expectedPA);
    const recentProjection = hrPerPARecent != null ? 1 - Math.pow(1 - hrPerPARecent, expectedPA) : seasonProjection;
    const contextProjection = 1 - Math.pow(1 - clamp(hrPerPA * pitcherHrMult * parkHrMult, 0.003, 0.18), expectedPA);
    const ensemble = frameworkBlend({
      market: "home_run",
      baseProjection: p,
      leagueBaseline,
      skillProjection: seasonProjection,
      recentProjection,
      contextProjection,
      floor,
      ceiling,
    });
    const pFinal = clamp(ensemble.projection * 0.74 + sim.home_run * 0.26, 0, 1);

    let verdict;
    let verdictNote;
    if (vegasHrProb != null) {
      const hi = Math.max(parkHrProb, vegasHrProb);
      const lo = Math.min(parkHrProb, vegasHrProb);
      verdict = pFinal > hi + 0.006 ? "strong" : pFinal >= lo - 0.006 ? "middling" : "fade";
      verdictNote = `Ours ${(pFinal * 100).toFixed(1)}% vs Park ${(parkHrProb * 100).toFixed(1)}% vs Vegas ${(vegasHrProb * 100).toFixed(1)}%.`;
    } else {
      verdict = pFinal > parkHrProb + 0.006 ? "strong" : pFinal >= parkHrProb - 0.006 ? "middling" : "fade";
      verdictNote = `Ours ${(pFinal * 100).toFixed(1)}% vs park baseline ${(parkHrProb * 100).toFixed(1)}% (no Vegas).`;
    }

    out.push({
      market: "home_run",
      confidence: toConfidence(pFinal, 0.1, 300),
      projection: pFinal,
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
          modelAgreement: ensemble.agreement,
          framework: ensemble.components,
        }),
        verdict,
        verdictNote,
        pOverLine: pFinal,
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
    const { expectedCount, floorCount, ceilingCount, floorProb, ceilingProb } = expectedCountRange(lambda, 0.72, 1.28, 2);
    const leagueBaseline = LEAGUE.tbPerPA * expectedPA;
    const seasonProjection = tbPerPASeason * expectedPA;
    const recentProjection = tbPerPARecent != null ? tbPerPARecent * expectedPA : seasonProjection;
    const contextProjection = clamp(tbPerPA * contactMult * clamp(1 + (parkFactor - 100) / 100 * 0.25, 0.88, 1.15), 0.12, 1.1) * expectedPA;
    const ensemble = frameworkBlend({
      market: "total_bases",
      baseProjection: expectedCount,
      leagueBaseline,
      skillProjection: seasonProjection,
      recentProjection,
      contextProjection,
      floor: floorCount,
      ceiling: ceilingCount,
    });
    const lambdaFinal = ensemble.projection;
    const pOver15 = clamp(poissonAtLeast(lambdaFinal, 2) * 0.72 + sim.total_bases * 0.28, 0, 1);
    out.push({
      market: "total_bases",
      confidence: toConfidence(pOver15, 0.5, 140),
      projection: pOver15,
      floor: floorProb,
      ceiling: ceilingProb,
      trigger,
      triggerStrength,
      features: baseFeatures(ctx, {
        tbPerPA,
        tbPerPAAdj,
        expectedCount: lambdaFinal,
        pOverLine: pOver15,
        tbOver1_5Prob: pOver15,
        modelAgreement: ensemble.agreement,
        framework: ensemble.components,
        monteCarloProb: sim.total_bases,
      }),
      dataQuality: dqBase,
      recommended: false,
      recScore: 0,
    });
  }

  {
    const lambda = hrrPerPAAdj * expectedPA;
    const { expectedCount, floorCount, ceilingCount } = expectedCountRange(lambda, 0.7, 1.3, 2);
    const leagueBaseline = LEAGUE.hrrPerPA * expectedPA;
    const seasonProjection = hrrPerPASeason * expectedPA;
    const recentProjection = hrrPerPARecent != null ? hrrPerPARecent * expectedPA : seasonProjection;
    const contextProjection = hrrPerPAAdj * expectedPA;
    const ensemble = frameworkBlend({
      market: "hrr_2",
      baseProjection: expectedCount,
      leagueBaseline,
      skillProjection: seasonProjection,
      recentProjection,
      contextProjection,
      floor: floorCount,
      ceiling: ceilingCount,
    });
    const lambdaFinal = ensemble.projection;
    const pOver15 = clamp(poissonAtLeast(lambdaFinal, 2) * 0.7 + sim.hrr_2 * 0.3, 0, 1);
    const pOver25 = clamp(poissonAtLeast(lambdaFinal, 3) * 0.72 + sim.hrr_3 * 0.28, 0, 1);
    out.push({
      market: "hrr_2",
      confidence: toConfidence(pOver15, 0.5, 145),
      projection: pOver15,
      floor: poissonAtLeast(floorCount, 2),
      ceiling: poissonAtLeast(ceilingCount, 2),
      trigger,
      triggerStrength,
      features: baseFeatures(ctx, {
        hrrPerPA,
        hrrPerPAAdj,
        expectedCount: lambdaFinal,
        pOverLine: pOver15,
        hrrOver1_5Prob: pOver15,
        modelAgreement: ensemble.agreement,
        framework: ensemble.components,
        monteCarloProb: sim.hrr_2,
        monteCarloSpread: sim.hrrSpread,
      }),
      dataQuality: dqBase,
      recommended: false,
      recScore: 0,
    });
    out.push({
      market: "hrr_3",
      confidence: toConfidence(pOver25, 0.32, 165),
      projection: pOver25,
      floor: poissonAtLeast(floorCount, 3),
      ceiling: poissonAtLeast(ceilingCount, 3),
      trigger,
      triggerStrength,
      features: baseFeatures(ctx, {
        hrrPerPA,
        hrrPerPAAdj,
        expectedCount: lambdaFinal,
        pOverLine: pOver25,
        hrrOver2_5Prob: pOver25,
        modelAgreement: ensemble.agreement,
        framework: ensemble.components,
        monteCarloProb: sim.hrr_3,
        monteCarloSpread: sim.hrrSpread,
      }),
      dataQuality: dqBase,
      recommended: false,
      recScore: 0,
    });
  }

  enforceHitterCoherence(out);

  const historicalReliability = clamp((seasonPA + recentPA * 0.85) / 260, 0, 1);
  const lineupQuality = clamp((expectedPA - 3.4) / 1.4, 0, 1);
  const matchupQuality = clamp((contactMult - 0.9) / 0.28, 0, 1);
  const recentForm = clamp(0.5 + recentHrDelta * 1.5, 0, 1);

  for (const s of out) {
    const pOver = Number.isFinite(s.projection) ? s.projection : (s.features?.pOverLine ?? 0.5);
    const agreement = Number(s.features?.modelAgreement ?? 0.5);
    const impliedProb = impliedMarketProb(s.market, s.features ?? {});
    const edge = pOver - impliedProb;
    s.features = {
      ...(s.features ?? {}),
      pOverLine: pOver,
      impliedMarketProb: impliedProb,
      modelEdge: edge,
      historicalReliability,
      matchupQuality,
      lineupQuality,
      recentForm,
      variancePenalty: variancePenalty(s.floor, s.ceiling),
    };
    s.confidence = confidenceFromSignals({
      market: s.market,
      prob: pOver,
      floor: s.floor,
      ceiling: s.ceiling,
      impliedProb,
      agreement,
      edge,
      historicalReliability,
      matchupQuality,
      lineupQuality,
      recentForm,
    });

    if (s.market === "home_run") {
      const liftVsPark = s.features?.liftVsPark ?? 0;
      const certainty = Math.max(0, 1 - (s.ceiling - s.floor) * 3.5);
      // STRONG verdict = model beats both park and Vegas baselines → meaningful edge signal
      // MIDDLING verdict = model sits between baselines → potential hidden edge
      const verdictBonus = s.verdict === "strong" ? 8 : s.verdict === "middling" ? 4 : 0;
      const recScore =
        s.confidence * 0.36 +
        pOver * 28 +
        Math.max(-0.08, edge) * 100 * 0.38 +
        Math.max(0, liftVsPark) * 110 +
        Math.max(0, s.triggerStrength) * 14 +
        certainty * 10 +
        verdictBonus;
      s.recScore = clamp(recScore, 0, 100);
      s.recommended = s.recScore >= 50 && s.dataQuality !== "missing" && edge > -0.03;
    } else {
      const recScore =
        s.confidence * 0.42 +
        pOver * 24 +
        Math.max(-0.08, edge) * 100 * 0.42 +
        Math.max(0, s.triggerStrength) * 15 +
        agreement * 8;
      s.recScore = clamp(recScore, 0, 100);
      s.recommended = s.recScore >= 49 && s.dataQuality !== "missing" && edge > -0.025;
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
  const floorCount = lambdaK * 0.72;
  const ceilingCount = lambdaK * 1.28;
  const ensemble = frameworkBlend({
    market: "strikeouts",
    baseProjection: lambdaK,
    leagueBaseline: expectedBF * leagueK,
    skillProjection: expectedBF * kRateSeason,
    recentProjection: expectedBF * kRateSeason,
    contextProjection: lambdaK,
    floor: floorCount,
    ceiling: ceilingCount,
  });
  const lambdaFinal = ensemble.projection;
  const pOver = poissonAtLeast(lambdaFinal, 7);
  const historicalReliability = clamp(((st.bf ?? 0) + (st.gs ?? 0) * 18) / 520, 0, 1);
  const matchupQuality = clamp((matchupMult - 0.85) / 0.35, 0, 1);
  const impliedProb = impliedMarketProb("strikeouts");
  const edge = pOver - impliedProb;

  const trigger =
    oppK > leagueK + 0.02
      ? `high-K offense (${(oppK * 100).toFixed(1)}%)`
      : oppK < leagueK - 0.02
        ? `low-K offense (${(oppK * 100).toFixed(1)}%)`
        : `K model ${(lambdaK).toFixed(2)} vs line 6.5`;
  const triggerStrength = clamp((matchupMult - 1) * 2.2, -1, 1);

  const pick = {
    market: "strikeouts",
    confidence: confidenceFromSignals({
      market: "strikeouts",
      prob: pOver,
      floor: poissonAtLeast(floorCount, 7),
      ceiling: poissonAtLeast(ceilingCount, 7),
      impliedProb,
      agreement: ensemble.agreement,
      edge,
      historicalReliability,
      matchupQuality,
      lineupQuality: 0.5,
      recentForm: 0.5,
    }),
    projection: lambdaFinal,
    floor: floorCount,
    ceiling: ceilingCount,
    trigger,
    triggerStrength,
    features: {
      kRateSeason,
      kRateAdj,
      oppTeamK: oppK,
      expectedIP,
      expectedBF,
      pOverLine: pOver,
      impliedMarketProb: impliedProb,
      modelEdge: edge,
      historicalReliability,
      matchupQuality,
      era: st.era,
      whip: st.whip,
      modelAgreement: ensemble.agreement,
      framework: ensemble.components,
    },
    dataQuality: dq,
    recommended: false,
    recScore: 0,
  };

  pick.recScore = clamp(
    pick.confidence * 0.42 +
      pOver * 26 +
      Math.max(-0.08, edge) * 100 * 0.46 +
      Math.max(0, pick.triggerStrength) * 12 +
      Number(pick.features?.modelAgreement ?? 0.5) * 8,
    0,
    100
  );
  pick.recommended = pick.recScore >= 54 && pick.dataQuality !== "missing" && edge > -0.025;

  return [pick];
}

export { expectedPAForBattingOrder };