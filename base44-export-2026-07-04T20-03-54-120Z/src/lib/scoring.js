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

function toConfidence(prob, anchor = 0.5, slope = 120) {
  const c = 50 + slope * (prob - anchor);
  return clamp(c, 0, 100);
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
  matchup["hr"] *= (ctx.parkFactorHr ?? 1.0) * (ctx.windHrMult ?? 1.0);
  
  // GB/FB ratio adjustment for HR
  if ((ctx.gbFbRatio ?? 1.0) > 0) {
    matchup["hr"] *= Math.pow(1.0 / (ctx.gbFbRatio), 0.3);
  }
  
  // Barrel% enhancement for HR
  if (ctx.barrelPct != null) {
    matchup["hr"] *= Math.pow(ctx.barrelPct / LEAGUE_AVG_BARREL_PCT, 0.4);
  }
  
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

function estimateExpectedPA(lineupSpot, teamImpliedTotal) {
  const basePA = LINEUP_PA_TABLE[lineupSpot] ?? 4.0;
  const totalAdj = Math.pow((teamImpliedTotal ?? LEAGUE_AVG_RUNS_PER_GAME) / LEAGUE_AVG_RUNS_PER_GAME, 0.15);
  return basePA * totalAdj;
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
  const expectedPA = estimateExpectedPA(ctx.lineupSpot ?? 5, ctx.teamImpliedTotal);
  
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
  const sim = simulateGame(batter, pitcher, ctx, nSims);
  
  const countProbs = (arr, threshold) => arr.filter(x => x >= threshold).length / arr.length;
  
  return {
    expectedPA: estimateExpectedPA(ctx.lineupSpot ?? 5, ctx.teamImpliedTotal),
    "2+ Hits": countProbs(sim.hits, 2),
    "2+ Total Bases": countProbs(sim.totalBases, 2),
    "3+ Total Bases": countProbs(sim.totalBases, 3),
    "1+ HR": countProbs(sim.homeRuns, 1),
    "2+ HRR": countProbs(sim.hrr, 2),
    "3+ HRR": countProbs(sim.hrr, 3),
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
  
  const expectedPA = estimateExpectedPA(ctx.battingOrder ?? 5, ctx.teamImpliedTotal);
  
  // Blend season baseline + recent form (shrinkage) + handedness split (shrinkage)
  const batter = buildBatterRates(ctx.season, ctx.recent, ctx.split ?? null);
  
  const pitcher = {
    "1b": (ctx.oppPitcherStats?.hits_allowed ?? 0) / Math.max(1, ctx.oppPitcherStats?.bf ?? 1) / 0.85,
    "2b": 0.045,
    "3b": 0.004,
    "hr": (ctx.oppPitcherStats?.hr_allowed ?? 0) / Math.max(1, ctx.oppPitcherStats?.bf ?? 1),
    "bb": (ctx.oppPitcherStats?.bb ?? 0) / Math.max(1, ctx.oppPitcherStats?.bf ?? 1),
    "hbp": 0.010,
    "k": ctx.oppPitcherK ?? LEAGUE_AVG.k,
  };
  
  const gameCtx = {
    parkFactor: (ctx.parkFactor ?? 100) / 100,
    parkFactor2b: ((ctx.parkFactor ?? 100) / 100) * 1.02,
    parkFactorHr: ((ctx.parkFactor ?? 100) / 100) * 1.12,
    windHrMult: 1.05,
    teamImpliedTotal: ctx.teamImpliedTotal ?? 4.5,
    onbaseRateAhead: ctx.onbaseRateAhead ?? 0.32,
    onbaseRateBehind: ctx.onbaseRateBehind ?? 0.32,
    gbFbRatio: ctx.oppPitcherGbFbRatio ?? 1.0,
    barrelPct: ctx.barrelPct,
    lineupSpot: ctx.battingOrder ?? 5,
  };
  
  const probs = computePropProbabilities(batter, pitcher, gameCtx);
  
  const markets = [
    { key: "hit_2", label: "2+ Hits", prob: probs["2+ Hits"], anchor: 0.5, slope: 120 },
    { key: "total_bases", label: "TB O1.5", prob: probs["2+ Total Bases"], anchor: 0.5, slope: 120 },
    { key: "hrr_2", label: "HRR O1.5", prob: probs["2+ HRR"], anchor: 0.5, slope: 120 },
    { key: "hrr_3", label: "HRR O2.5", prob: probs["3+ HRR"], anchor: 0.5, slope: 120 },
    { key: "home_run", label: "Home Run", prob: probs["1+ HR"], anchor: 0.5, slope: 120 },
  ];
  
  const trigger = `HR ${(batter.hr * 100).toFixed(1)}%, Contact ${(batter["1b"] * 100).toFixed(1)}%`;
  const triggerStrength = clamp((ctx.oppPitcherK - LEAGUE_AVG.k) * 2, -1, 1);
  
  for (const m of markets) {
    const floor = Math.max(0, m.prob - 0.15);
    const ceiling = Math.min(1, m.prob + 0.15);
    
    out.push({
      market: m.key,
      confidence: toConfidence(m.prob, m.anchor, m.slope),
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
  
  out.push({
    market: "strikeouts",
    confidence: toConfidence(projK / 9, 0.6, 80),
    projection: projK,
    floor: projK * 0.7,
    ceiling: projK * 1.35,
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
  
  const pitcher = {
    "1b": (ctx.oppPitcherStats?.hits_allowed ?? 0) / Math.max(1, ctx.oppPitcherStats?.bf ?? 1) / 0.85,
    "2b": 0.045,
    "3b": 0.004,
    "hr": (ctx.oppPitcherStats?.hr_allowed ?? 0) / Math.max(1, ctx.oppPitcherStats?.bf ?? 1),
    "bb": (ctx.oppPitcherStats?.bb ?? 0) / Math.max(1, ctx.oppPitcherStats?.bf ?? 1),
    "hbp": 0.010,
    "k": ctx.oppPitcherK ?? LEAGUE_AVG.k,
  };
  
  const gameCtx = {
    parkFactor: (ctx.parkFactor ?? 100) / 100,
    parkFactor2b: ((ctx.parkFactor ?? 100) / 100) * 1.02,
    parkFactorHr: ((ctx.parkFactor ?? 100) / 100) * 1.12,
    windHrMult: 1.05,
    teamImpliedTotal: ctx.teamImpliedTotal ?? 4.5,
    onbaseRateAhead: ctx.onbaseRateAhead ?? 0.32,
    onbaseRateBehind: ctx.onbaseRateBehind ?? 0.32,
    gbFbRatio: ctx.oppPitcherGbFbRatio ?? 1.0,
    barrelPct: ctx.barrelPct,
    lineupSpot: ctx.battingOrder ?? 5,
  };
  
  return simulateGame(batter, pitcher, gameCtx, 100000);
}

export { scoreHitterV2 as scoreHitter, scorePitcherV2 as scorePitcher };
