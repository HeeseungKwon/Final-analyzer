
/**
 * Analysis Engine v2: Monte Carlo-based MLB Prop Analyzer
 * 
 * Implements sophisticated multi-source analysis combining:
 * - Credibility-weighted blending (season/recent/split)
 * - Log5 matchup modeling (Bill James)
 * - Park factor & weather adjustments
 * - Expected PA calculation
 * - Correlated Monte Carlo simulation (preserves Hit/TB/HR/Run/RBI relationships)
 * - Prob-exceeding-threshold aggregation per market
 */

const LEAGUE_AVG = {
  "1b": 0.140, "2b": 0.045, "3b": 0.004, "hr": 0.033,
  "bb": 0.083, "hbp": 0.010, "k": 0.225,
};

const LEAGUE_AVG_RUNS_PER_GAME = 4.5;
const LEAGUE_AVG_BARREL_PCT = 0.075;
const ESTIMATED_SINGLE_SHARE_OF_HITS = 0.85;
const STRIKEOUT_MARKET = "strikeouts";
const MIN_PROBABILITY = 0.01;
const MAX_PROBABILITY = 0.99;
// 10th/90th percentile bands span ~2.56 standard deviations in a normal model.
const INFERRED_STDDEV_Z_SPREAD = 2.56;
// Keep inferred strikeout distributions from collapsing unrealistically tight.
const MIN_INFERRED_STDDEV = 0.85;
// Fallback spread when only the mean projection is available.
const PROJECTION_STDDEV_RATIO = 0.18;

const LINEUP_PA_TABLE = {
  1: 4.65, 2: 4.55, 3: 4.45, 4: 4.35, 5: 4.25,
  6: 4.10, 7: 3.95, 8: 3.80, 9: 3.65,
};

function credibilityWeight(n, k) {
  return n / (n + k);
}

function blend(season, recent, wSeason = 0.45, wRecent = 0.30, wVsh = 0.25, kRecent = 45, kVsh = 70) {
  if (!season && !recent) return null;
  if (!season) return recent;
  if (!recent) return season;
  
  const leagueAvg = 0.5;
  const crRecent = credibilityWeight(recent.pa ?? 0, kRecent);
  const crVsh = credibilityWeight(recent.pa ?? 0, kVsh);
  
  const recentAdj = recent * crRecent + leagueAvg * (1 - crRecent);
  const vshAdj = recent * crVsh + leagueAvg * (1 - crVsh);
  
  const total = wSeason + wRecent + wVsh;
  return (season * wSeason + recentAdj * wRecent + vshAdj * wVsh) / total;
}

function log5(batterRate, pitcherRate, leagueRate) {
  const lr = Math.max(Math.min(leagueRate, 1 - 1e-6), 1e-6);
  const br = Math.max(Math.min(batterRate, 1 - 1e-6), 1e-6);
  const pr = Math.max(Math.min(pitcherRate, 1 - 1e-6), 1e-6);
  
  const num = br * pr / lr;
  const den = num + (1 - br) * (1 - pr) / (1 - lr);
  return num / den;
}

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

function erf(x) {
  // Abramowitz & Stegun 7.1.26 approximation; accurate to roughly 1.5e-7.
  const sign = x < 0 ? -1 : 1;
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const absX = Math.abs(x);
  const t = 1 / (1 + p * absX);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX);
  return sign * y;
}

function normalCdf(x, mean = 0, stdDev = 1) {
  if (!Number.isFinite(stdDev) || stdDev <= 0) {
    return x >= mean ? 1 : 0;
  }
  return 0.5 * (1 + erf((x - mean) / (stdDev * Math.sqrt(2))));
}

function toConfidence(prob) {
  const p = Number(prob);
  return Math.round(clamp(Number.isFinite(p) ? p : 0, 0, 1) * 100);
}

/**
 * Build per-PA outcome rates by credibility-weighted blending of season, recent form, and handedness split.
 *
 * Shrinkage constants:
 *   K_RECENT = 50  → need 50 PA for 50% credibility on recent form (avoids hot-streak overreaction)
 *   K_SPLIT  = 150 → splits are noisier; need 150 PA for 50% credibility
 *
 * 1B rate is correctly computed as (hits - 2B - 3B - HR) / PA.
 */
function buildBatterRates(season, recent, split) {
  const K_RECENT = 50;
  const K_SPLIT  = 150;

  function ratesFromStats(stats) {
    const pa = stats?.pa ?? 0;
    if (pa === 0) return null;
    const singles = Math.max(0,
      (stats.hits ?? 0) - (stats.doubles ?? 0) - (stats.triples ?? 0) - (stats.home_runs ?? 0)
    );
    return {
      "1b":  singles / pa,
      "2b":  (stats.doubles    ?? 0) / pa,
      "3b":  (stats.triples    ?? 0) / pa,
      "hr":  (stats.home_runs  ?? 0) / pa,
      "bb":  (stats.bb         ?? 0) / pa,
      "hbp": (stats.hbp        ?? 0) / pa,
      "k":   (stats.so         ?? 0) / pa,
    };
  }

  const seasonRates = ratesFromStats(season);
  const recentRates = ratesFromStats(recent);
  const splitRates  = ratesFromStats(split);

  // No season data at all → fall back to league average
  if (!seasonRates) {
    return { "1b": LEAGUE_AVG["1b"], "2b": LEAGUE_AVG["2b"], "3b": LEAGUE_AVG["3b"],
             "hr": LEAGUE_AVG.hr, "bb": LEAGUE_AVG.bb, "hbp": 0.010, "k": LEAGUE_AVG.k };
  }

  const outcomes = ["1b", "2b", "3b", "hr", "bb", "hbp", "k"];
  // Credibility weights (Bayesian shrinkage): n / (n + K)
  const crRecent = recent?.pa ? recent.pa / (recent.pa + K_RECENT) : 0;
  const crSplit  = split?.pa  ? split.pa  / (split.pa  + K_SPLIT)  : 0;

  const result = {};
  for (const o of outcomes) {
    const sRate = seasonRates[o] ?? LEAGUE_AVG[o] ?? 0;
    // Step 1: blend recent form with credibility shrinkage toward season baseline
    const afterRecent = recentRates
      ? (1 - crRecent) * sRate + crRecent * (recentRates[o] ?? sRate)
      : sRate;
    // Step 2: blend handedness split (capped at 40% influence to avoid small-sample noise)
    const afterSplit = splitRates
      ? (1 - 0.4 * crSplit) * afterRecent + 0.4 * crSplit * (splitRates[o] ?? afterRecent)
      : afterRecent;
    result[o] = afterSplit;
  }

  return result;
}

/**
 * Estimate PA outcome probabilities with Log5 + park/weather adjustments
 */
const MARKET_FEATURE_WEIGHTS = {
  home_run: {
    // PowerScore is the single retained power representation. Its source
    // components (Barrel%, HardHit%, xISO, etc.) are not added separately.
    power_score: 1.00,
  },
  hit_2: {
    // Log5 hit rates remain primary; ContactScore is retained only as a
    // small residual contact-quality adjustment.
    contact_score: 1.00,
  },
  total_bases: {
    // Log5 supplies the hit baseline; PowerScore is the one retained
    // extra-base-quality signal and is applied by outcome below.
    power_score: 1.00,
  },
  hrr_2: {
    // Expected PA already owns lineup/opportunity/run-context effects.
    // Only independent availability/late-inning inputs remain here.
    fatigue_adjustment: 0.50,
    bullpen_adjustment: 0.50,
  },
  hrr_3: {
    fatigue_adjustment: 0.50,
    bullpen_adjustment: 0.50,
  },
};

function derivedScore(ctx, snakeName, legacyName) {
  const value = ctx?.derivedFeatures?.[snakeName] ?? ctx?.derivedFeatures?.[legacyName];
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function derivedZ(score) {
  return (score - 50) / 50;
}

function rawFeatureSignal(ctx, key) {
  const aliases = {
    barrel_pct: ["barrelPct", "barrel_pct", "BarrelPct"],
    hard_hit_pct: ["hardHitPct", "hard_hit_pct", "HardHitPct"],
    xba: ["xBA", "xba", "x_ba"],
    babip: ["babip", "BABIP"],
  };
  const value = aliases[key]?.map((name) => ctx?.[name] ?? ctx?.derivedFeatures?.[name]).find((item) => item != null);
  if (value == null || !Number.isFinite(Number(value))) return null;
  const baselines = { barrel_pct: 0.075, hard_hit_pct: 0.35, xba: 0.250, babip: 0.300 };
  const baseline = baselines[key];
  return clamp((Number(value) - baseline) / baseline, -1, 1);
}

function featureSignal(ctx, key) {
  if (key === "park") return clamp(((Number(ctx.parkFactor) || 1) - 1) / 0.20, -1, 1);
  if (key === "weather") return clamp(Math.log(Number(ctx.windHrMult) || 1) / Math.log(1.10), -1, 1);
  if (key === "batting_order") return clamp((5 - (ctx.lineupSpot ?? 5)) / 4, -1, 1);
  if (key === "expected_pa") return clamp((Number(ctx.expectedPAValue ?? 4.1) - 4.1) / 0.8, -1, 1);
  if (key === "fatigue_adjustment") {
    const score = derivedScore(ctx, key, "FatigueAdjustment");
    return score == null ? null : derivedZ(score);
  }
  if (key === "bullpen_adjustment") {
    const score = derivedScore(ctx, key, "BullpenAdjustment");
    return score == null ? null : -derivedZ(score);
  }
  const raw = rawFeatureSignal(ctx, key);
  if (raw != null) return raw;
  const legacy = { power_score: "PowerScore", quality_of_contact: "QualityOfContact", contact_score: "ContactScore", plate_discipline: "PlateDiscipline", matchup_score: "MatchupScore", opportunity_score: "OpportunityScore", run_environment: "RunEnvironment", recent_form: "RecentForm" }[key];
  const score = derivedScore(ctx, key, legacy);
  // Use raw Barrel% only as a fallback when the aggregate PowerScore is not
  // present; never combine both representations.
  if (key === "power_score" && score == null) return rawFeatureSignal(ctx, "barrel_pct");
  return score == null ? null : derivedZ(score);
}

function marketFeatureComposite(ctx) {
  const weights = MARKET_FEATURE_WEIGHTS[ctx.market];
  if (!weights) return 0;
  let total = 0;
  let weight = 0;
  for (const [key, importance] of Object.entries(weights)) {
    const signal = featureSignal(ctx, key);
    if (signal == null) continue;
    total += importance * signal;
    weight += importance;
  }
  return weight ? total / weight : 0;
}

function applyMarketFeatureAdjustments(matchup, ctx) {
  const composite = marketFeatureComposite(ctx);
  // Each market has a distinct feature map above. The small caps keep these
  // adjustments from overpowering season/recent/split rates already in Log5.
  if (ctx.market === "home_run") {
    matchup.hr *= clamp(1 + 0.16 * composite, 0.84, 1.16);
  } else if (ctx.market === "hit_2") {
    for (const outcome of ["1b", "2b", "3b"]) matchup[outcome] *= clamp(1 + 0.05 * composite, 0.95, 1.05);
    matchup.k *= clamp(1 - 0.04 * composite, 0.96, 1.04);
  } else if (ctx.market === "total_bases") {
    // Power should affect extra-base outcomes more than singles. Park factors
    // are already applied separately by outcome above.
    matchup["2b"] *= clamp(1 + 0.08 * composite, 0.92, 1.08);
    matchup["3b"] *= clamp(1 + 0.10 * composite, 0.90, 1.10);
    matchup.hr *= clamp(1 + 0.14 * composite, 0.86, 1.14);
  }
}

function estimatePAOutcomeProbs(batter, pitcher, ctx) {
  const outcomes = ["1b", "2b", "3b", "hr", "bb", "hbp", "k"];
  const matchup = {};
  
  for (const o of outcomes) {
    const bRate = batter[o] ?? LEAGUE_AVG[o];
    const pRate = pitcher[o] ?? LEAGUE_AVG[o];
    matchup[o] = log5(bRate, pRate, LEAGUE_AVG[o]);
  }
  
  // Park factor & weather adjustments
  matchup["1b"] *= (ctx.parkFactor ?? 1.0);
  matchup["2b"] *= (ctx.parkFactor2b ?? 1.0);
  matchup["3b"] *= (ctx.parkFactor3b ?? ctx.parkFactor2b ?? 1.0);
  matchup["hr"] *= (ctx.parkFactorHr ?? 1.0) * (ctx.windHrMult ?? 1.0);
  
  // GB/FB ratio adjustment for HR
  if ((ctx.gbFbRatio ?? 1.0) > 0) {
    matchup["hr"] *= Math.pow(1.0 / (ctx.gbFbRatio), 0.3);
  }
  
  applyMarketFeatureAdjustments(matchup, ctx);
  
  // Ensure sum doesn't exceed 0.85
  let totalNonOut = Object.values(matchup).reduce((a, b) => a + b, 0);
  if (totalNonOut > 0.85) {
    const scale = 0.85 / totalNonOut;
    for (const o of outcomes) matchup[o] *= scale;
    totalNonOut = 0.85;
  }
  
  matchup["out"] = 1 - totalNonOut;
  return matchup;
}

function estimateExpectedPA(lineupSpot, teamImpliedTotal, ctx = {}) {
  const basePA = LINEUP_PA_TABLE[lineupSpot] ?? 4.0;
  const totalAdj = Math.pow((teamImpliedTotal ?? LEAGUE_AVG_RUNS_PER_GAME) / LEAGUE_AVG_RUNS_PER_GAME, 0.15);
  const starterIP = Number(ctx.opponentStarterExpectedIP);
  const starterExposure = Number.isFinite(starterIP) ? clamp((9 - starterIP) / 4, 0, 1) : 0;
  const parkRunFactor = Number(ctx.parkFactor);

  // TODO: Add a bullpen-only quality feed. The current MLB Stats API payload
  // has no reliever split, so BullpenAdjustment is honored only when supplied
  // by the derived layer and is never fabricated here.
  // More innings from the opposing starter generally means fewer late-game
  // plate appearances; weaker available bullpen data is used only when the
  // derived layer supplies it. No bullpen quality is fabricated here.
  const starterAdj = Number.isFinite(starterIP) ? 1 - 0.025 * starterExposure : 1;
  const parkAdj = Number.isFinite(parkRunFactor) ? 1 + 0.025 * (parkRunFactor - 1) : 1;
  const baselinePA = basePA * totalAdj * starterAdj * parkAdj;
  if (ctx.market !== "hrr_2" && ctx.market !== "hrr_3") return baselinePA;

  // HRR is the market where opportunity and scoring context should alter PA
  // most directly; the other markets retain the shared PA baseline so their
  // derived features affect their own outcome probabilities instead.
  const marketComposite = marketFeatureComposite({ ...ctx, expectedPAValue: baselinePA });
  return baselinePA * clamp(1 + 0.045 * marketComposite, 0.955, 1.045);
}

/**
 * Simulate game with correlated outcomes
 * Draws Hit/TB/HR and Run/RBI together per PA to preserve relationships
 * 
 * Run/RBI estimation refined to use:
 * - onbase_rate_behind: affects probability of scoring after getting on base
 * - onbase_rate_ahead: affects probability of getting RBI
 * - team_implied_total: overall scoring environment
 * - outcome type: extra base hits get higher RBI probability
 */
function simulateGame(batter, pitcher, ctx, nSims = 100000) {
  const outcomes = ["1b", "2b", "3b", "hr", "bb", "hbp", "k", "out"];
  const probs = estimatePAOutcomeProbs(batter, pitcher, ctx);
  const expectedPA = estimateExpectedPA(ctx.lineupSpot ?? 5, ctx.teamImpliedTotal, ctx);
  
  const p = outcomes.map(o => probs[o] ?? 0);
  const pSum = p.reduce((a, b) => a + b, 0);
  const pNorm = p.map(x => x / pSum);
  
  const paFloor = Math.floor(expectedPA);
  const paFrac = expectedPA - paFloor;
  
  const totalHits = new Array(nSims).fill(0);
  const totalTB = new Array(nSims).fill(0);
  const totalHR = new Array(nSims).fill(0);
  const totalRuns = new Array(nSims).fill(0);
  const totalRBI = new Array(nSims).fill(0);
  
  const rng = Math.random;
  
  for (let sim = 0; sim < nSims; sim++) {
    const nPA = rng() < paFrac ? paFloor + 1 : paFloor;
    
    for (let pa = 0; pa < nPA; pa++) {
      const r = rng();
      let cumP = 0;
      let outcome = "out";
      
      for (let i = 0; i < outcomes.length; i++) {
        cumP += pNorm[i];
        if (r < cumP) {
          outcome = outcomes[i];
          break;
        }
      }
      
      const is1b = outcome === "1b";
      const is2b = outcome === "2b";
      const is3b = outcome === "3b";
      const isHR = outcome === "hr";
      const isBB = outcome === "bb";
      const isHBP = outcome === "hbp";
      const isOnBase = is1b || is2b || is3b || isHR || isBB || isHBP;
      
      // Hit tracking
      if (is1b || is2b || is3b || isHR) totalHits[sim]++;
      
      // Total Bases tracking
      if (is1b) totalTB[sim] += 1;
      else if (is2b) totalTB[sim] += 2;
      else if (is3b) totalTB[sim] += 3;
      else if (isHR) totalTB[sim] += 4;
      
      if (isHR) totalHR[sim]++;
      
      // --- Run estimation (refined)
      // HR is always a run for the batter. Non-HR runners get base-dependent probability
      // Run prob scales with onbase_rate_behind (more runners on base → more chances to score)
      const onbaseRateBehind = ctx.onbaseRateBehind ?? 0.320;
      const teamImpliedTotal = ctx.teamImpliedTotal ?? LEAGUE_AVG_RUNS_PER_GAME;
      const runProbIfOnbase = Math.max(0.10, Math.min(0.55,
        0.22 
        + 0.55 * (onbaseRateBehind - LEAGUE_AVG.bb) * 3
        + 0.05 * (teamImpliedTotal - LEAGUE_AVG_RUNS_PER_GAME)
      ));
      
      if (isHR) {
        totalRuns[sim]++;
      } else if (isOnBase && rng() < runProbIfOnbase) {
        totalRuns[sim]++;
      }
      
      // --- RBI estimation (refined)
      // RBI probability depends on:
      // 1. Outcome type (singles have lower RBI prob than extra base hits)
      // 2. onbase_rate_ahead (runners already on base)
      // 3. For HR: guaranteed 1 RBI + potential extra for runners on base
      const onbaseRateAhead = ctx.onbaseRateAhead ?? 0.320;
      
      // Base RBI probabilities for singles, doubles, triples
      const rbiProb1b = Math.max(0.03, Math.min(0.30,
        0.10 + 0.5 * (onbaseRateAhead - 0.32)
      ));
      const rbiProb2b = Math.max(0.10, Math.min(0.55,
        0.28 + 0.6 * (onbaseRateAhead - 0.32)
      ));
      const rbiProb3b = Math.max(0.20, Math.min(0.75,
        0.45 + 0.6 * (onbaseRateAhead - 0.32)
      ));
      
      // Apply RBI outcomes
      if (is1b && rng() < rbiProb1b) totalRBI[sim]++;
      else if (is2b && rng() < rbiProb2b) totalRBI[sim]++;
      else if (is3b && rng() < rbiProb3b) totalRBI[sim]++;
      
      // HR: guaranteed 1 RBI + potential extra RBIs from runners on base
      if (isHR) {
        totalRBI[sim]++;
        // Extra RBI chance (runners already on base score)
        const extraRBIProb = Math.max(0, Math.min(1, onbaseRateAhead * 1.8));
        if (rng() < extraRBIProb) totalRBI[sim]++;
      }
    }
  }
  
  const hrrTotal = totalHits.map((h, i) => h + totalRuns[i] + totalRBI[i]);
  
  return {
    hits: totalHits,
    totalBases: totalTB,
    homeRuns: totalHR,
    runs: totalRuns,
    rbi: totalRBI,
    hrr: hrrTotal,
  };
}

/**
 * Compute final market probabilities from simulation
 */
function computePropProbabilities(batter, pitcher, ctx, nSims = 100000) {
  const countProbs = (arr, threshold) => arr.filter(x => x >= threshold).length / arr.length;
  const markets = [
    ["hit_2", "2+ Hits", "hits", 2],
    ["total_bases", "2+ Total Bases", "totalBases", 2],
    ["total_bases", "3+ Total Bases", "totalBases", 3],
    ["home_run", "1+ HR", "homeRuns", 1],
    ["hrr_2", "2+ HRR", "hrr", 2],
    ["hrr_3", "3+ HRR", "hrr", 3],
  ];
  const probabilities = {
    expectedPA: estimateExpectedPA(ctx.lineupSpot ?? 5, ctx.teamImpliedTotal, ctx),
  };
  const simulations = {};

  // Each market receives its own pre-simulation feature adjustment model while
  // retaining the correlated outcome generation inside every simulation.
  for (const [market, label, series, threshold] of markets) {
    simulations[market] ??= simulateGame(batter, pitcher, { ...ctx, market }, nSims);
    const sim = simulations[market];
    probabilities[label] = countProbs(sim[series], threshold);
  }
  return probabilities;
}

function buildPitcherRates(ctx) {
  // TODO: Fetch xFIP, SIERA, CSW%, Stuff+, Location+, Pitching+, barrel
  // allowed, hard-hit allowed, and swinging-strike rate from a Statcast or
  // trusted pitching source. Current verified fallbacks are K%, HR/BF, BB/BF,
  // and GB/FB from the MLB Stats API.
  const rawBf = Number(ctx?.oppPitcherStats?.bf);
  const hasPitcherStats = Number.isFinite(rawBf) && rawBf > 0;
  const bf = hasPitcherStats ? rawBf : null;

  const statHitsAllowed = hasPitcherStats ? Number(ctx?.oppPitcherStats?.hits_allowed ?? 0) : null;
  const statHrAllowed = hasPitcherStats ? Number(ctx?.oppPitcherStats?.hr_allowed ?? 0) : null;
  const statBb = hasPitcherStats ? Number(ctx?.oppPitcherStats?.bb ?? 0) : null;
  const hrPerBfFallback = Number(ctx?.oppPitcherHrPerBF);

  const singleRate = hasPitcherStats
    // hits_allowed includes singles + extra-base hits; estimate 1B/BF as ~85% of total hits/BF.
    ? Math.max(0, (statHitsAllowed * ESTIMATED_SINGLE_SHARE_OF_HITS) / bf)
    : LEAGUE_AVG["1b"];
  const hrRate = hasPitcherStats
    ? Math.max(0, statHrAllowed / bf)
    : (Number.isFinite(hrPerBfFallback) ? Math.max(0, hrPerBfFallback) : LEAGUE_AVG.hr);
  const bbRate = hasPitcherStats
    ? Math.max(0, statBb / bf)
    : LEAGUE_AVG.bb;

  return {
    "1b": singleRate,
    // We can infer singles from aggregate hits_allowed, but this context does not include pitcher 2B/3B splits.
    // Keep league 2B/3B baselines for stability instead of inventing noisy estimates.
    "2b": LEAGUE_AVG["2b"],
    "3b": LEAGUE_AVG["3b"],
    "hr": hrRate,
    "bb": bbRate,
    "hbp": LEAGUE_AVG.hbp,
    "k": ctx?.oppPitcherK ?? LEAGUE_AVG.k,
  };
}

/**
 * Wrapper for current scoreHitter API compatibility
 * Converts new engine output to existing format
 */
export function scoreHitterV2(name, ctx) {
  const out = [];
  
  const dqBase = !ctx.season && !ctx.recent
    ? "missing"
    : (ctx.season?.quality === "partial" || ctx.recent?.quality === "partial" || !ctx.season || !ctx.recent)
      ? "partial"
      : "ok";
  
  const expectedPA = estimateExpectedPA(ctx.battingOrder ?? 5, ctx.teamImpliedTotal, {
    ...ctx,
    parkFactor: (ctx.parkFactor ?? 100) / 100,
  });
  
  // Blend season baseline + recent form (shrinkage) + handedness split (shrinkage)
  const batter = buildBatterRates(ctx.season, ctx.recent, ctx.split ?? null);
  const pitcher = buildPitcherRates(ctx);
  
  const gameCtx = {
    parkFactor: (ctx.parkFactor ?? 100) / 100,
    // Only a verified venue factor is available. Component-specific and
    // handedness-specific park factors remain TODO until supplied upstream.
    parkFactor2b: (ctx.parkFactor ?? 100) / 100,
    parkFactor3b: (ctx.parkFactor ?? 100) / 100,
    parkFactorHr: (ctx.parkFactor ?? 100) / 100,
    // Weather/wind are not present in the current game payload. A neutral
    // multiplier avoids systematic HR inflation until a weather feed exists.
    windHrMult: ctx.windHrMult,
    teamImpliedTotal: ctx.teamImpliedTotal ?? 4.5,
    onbaseRateAhead: ctx.onbaseRateAhead ?? 0.32,
    onbaseRateBehind: ctx.onbaseRateBehind ?? 0.32,
    gbFbRatio: ctx.oppPitcherGbFbRatio ?? 1.0,
    barrelPct: ctx.barrelPct,
    lineupSpot: ctx.battingOrder ?? 5,
    opponentStarterExpectedIP: ctx.opponentStarterExpectedIP,
    derivedFeatures: ctx.derivedFeatures,
    market: ctx.market,
  };
  
  const probs = computePropProbabilities(batter, pitcher, gameCtx);
  
  const markets = [
    { key: "hit_2", label: "2+ Hits", prob: probs["2+ Hits"] },
    { key: "total_bases", label: "TB O1.5", prob: probs["2+ Total Bases"] },
    { key: "hrr_2", label: "HRR O1.5", prob: probs["2+ HRR"] },
    { key: "hrr_3", label: "HRR O2.5", prob: probs["3+ HRR"] },
    { key: "home_run", label: "Home Run", prob: probs["1+ HR"] },
  ];
  
  const trigger = `HR ${(batter.hr * 100).toFixed(1)}%, Contact ${(batter["1b"] * 100).toFixed(1)}%`;
  const triggerStrength = clamp((ctx.oppPitcherK - LEAGUE_AVG.k) * 2, -1, 1);
  
  for (const m of markets) {
    const floor = Math.max(0, m.prob - 0.15);
    const ceiling = Math.min(1, m.prob + 0.15);
    
    out.push({
      market: m.key,
      confidence: toConfidence(m.prob),
      projection: m.prob,
      floor,
      ceiling,
      trigger,
      triggerStrength,
      features: {
        expectedPA,
        battingOrder: ctx.battingOrder ?? null,
        oppPitcherK: ctx.oppPitcherK ?? null,
        parkFactor: ctx.parkFactor ?? 100,
        pOverLine: m.prob,
      },
      dataQuality: dqBase,
      recommended: false,
      recScore: 0,
      verdict: m.prob > 0.6 ? "strong" : m.prob > 0.4 ? "middling" : "fade",
      verdictNote: `${m.label}: ${(m.prob * 100).toFixed(1)}% projected`,
    });
  }
  
  return out;
}

export function scorePitcherV2(name, ctx) {
  const out = [];
  const st = ctx.season;
  if (!st) return out;
  
  const dq = st.quality === "partial" ? "partial" : "ok";
  const oppK = ctx.oppTeamK ?? LEAGUE_AVG.k;
  const matchupMult = 1 + (oppK - LEAGUE_AVG.k) * 1.5;
  
  const kPer9 = (st.k_per_9 ?? 0) * matchupMult;
  const expectedIP = ctx.expectedIP ?? 5.5;
  const projK = (kPer9 / 9) * expectedIP;
  
  const trigger = oppK > LEAGUE_AVG.k + 0.02 ? `high-K offense (${(oppK * 100).toFixed(1)}%)` : `${kPer9.toFixed(1)} K/9`;
  const triggerStrength = clamp((matchupMult - 1) * 3, -1, 1);
  
  const strikeoutLine = ctx.strikeoutLine ?? 5.5;
  const kFloor = projK * 0.7;
  const kCeiling = projK * 1.35;
  const kStdDev = Math.max(MIN_INFERRED_STDDEV, Math.abs(kCeiling - kFloor) / INFERRED_STDDEV_Z_SPREAD);
  const strikeoutProb = clamp(1 - normalCdf(strikeoutLine, projK, kStdDev), MIN_PROBABILITY, MAX_PROBABILITY);

  out.push({
    market: "strikeouts",
    confidence: toConfidence(strikeoutProb),
    projection: projK,
    floor: kFloor,
    ceiling: kCeiling,
    trigger,
    triggerStrength,
    features: {
      kPer9: st.k_per_9,
      adjustedKPer9: kPer9,
      oppTeamK: oppK,
      expectedIP,
      era: st.era,
    },
    dataQuality: dq,
    recommended: false,
    recScore: 0,
  });
  
  return out;
}

export function parkFactorFor(homeTeamId) {
  const HR_PARK_FACTOR = {
    115: 118, 113: 116, 140: 113, 143: 111, 147: 110, 158: 108, 110: 108,
    112: 106, 141: 105, 111: 104, 109: 102, 144: 102, 120: 101, 108: 101,
    142: 100, 145: 99, 119: 99, 135: 97, 117: 96, 118: 96, 139: 95,
    116: 94, 134: 93, 138: 92, 133: 92, 114: 91, 136: 90, 121: 89, 146: 87, 137: 85,
  };
  return homeTeamId ? (HR_PARK_FACTOR[homeTeamId] ?? 100) : 100;
}

/**
 * Get simulation data for projection scoring
 * Used by projection-scorer.js to enrich predictions
 */
export function getHitterSimulationData(ctx) {
  // Blend season baseline + recent form (shrinkage) + handedness split (shrinkage)
  const batter = buildBatterRates(ctx.season, ctx.recent, ctx.split ?? null);
  const pitcher = buildPitcherRates(ctx);
  
  const gameCtx = {
    parkFactor: (ctx.parkFactor ?? 100) / 100,
    // No component-specific or handedness-specific park feed is available.
    parkFactor2b: (ctx.parkFactor ?? 100) / 100,
    parkFactor3b: (ctx.parkFactor ?? 100) / 100,
    parkFactorHr: (ctx.parkFactor ?? 100) / 100,
    // Weather/wind are not present in the current game payload.
    windHrMult: ctx.windHrMult,
    teamImpliedTotal: ctx.teamImpliedTotal ?? 4.5,
    onbaseRateAhead: ctx.onbaseRateAhead ?? 0.32,
    onbaseRateBehind: ctx.onbaseRateBehind ?? 0.32,
    gbFbRatio: ctx.oppPitcherGbFbRatio ?? 1.0,
    barrelPct: ctx.barrelPct,
    lineupSpot: ctx.battingOrder ?? 5,
    opponentStarterExpectedIP: ctx.opponentStarterExpectedIP,
    derivedFeatures: ctx.derivedFeatures,
    market: ctx.market,
  };
  
  return simulateGame(batter, pitcher, gameCtx, 100000);
}

export { scoreHitterV2 as scoreHitter, scorePitcherV2 as scorePitcher };
