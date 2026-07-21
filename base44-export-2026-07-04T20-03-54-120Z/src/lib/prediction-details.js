function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// Treat stored confidence as a unique reliability signal only when it differs
// from model probability by at least 0.005 (0.5 percentage points).
const CONFIDENCE_DIVERGENCE_THRESHOLD = 0.005;
const QUALITY_SCORES = {
  good: 78,
  partial: 62,
  limited: 44,
};
const SAMPLE_THRESHOLDS = {
  season: 280,
  recent: 80,
  pitcher: 350,
};
const SAMPLE_WEIGHTS = {
  season: 0.5,
  recent: 0.25,
  pitcher: 0.25,
};
const CONFIDENCE_COMPONENT_WEIGHTS = {
  quality: 0.30,
  completeness: 0.20,
  sample: 0.20,
  lineup: 0.10,
  pitcher: 0.10,
  consistency: 0.10,
};
const DRIVER_THRESHOLDS = {
  elitePowerScore: 0.70,
  eliteHrRate: 0.055,
  strongMatchupScore: 0.62,
  strongRecentForm: 0.62,
  favorableParkFactor: 105,
  highExpectedPA: 4.3,
  premiumBattingOrder: 3,
  hotStreakDeltaAvg: 0.02,
  strongRunEnvironment: 4.9,
  strongOpportunityScore: 0.62,
};

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toPercentLabel(value, digits = 0) {
  const parsed = toNumber(value);
  if (parsed === null) return "—";
  return `${(parsed * 100).toFixed(digits)}%`;
}

function normalizeDataQuality(dataQuality) {
  const key = String(dataQuality ?? "").toLowerCase();
  if (key === "ok" || key === "good") {
    return { key: "good", label: "Good", badgeClassName: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400" };
  }
  if (key === "partial") {
    return { key: "partial", label: "Partial", badgeClassName: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400" };
  }
  return { key: "limited", label: "Limited", badgeClassName: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400" };
}

function hasNumber(value) {
  return Number.isFinite(Number(value));
}

function normalizeDriverLabel(label) {
  if (typeof label !== "string") return null;
  const trimmed = label.trim();
  if (!trimmed) return null;
  return trimmed
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

function inferRecommendationDrivers(prediction, features = {}) {
  const drivers = [];
  const derived = features?.derivedFeatures ?? {};
  const season = features?.season ?? {};
  const recent = features?.recent ?? {};
  const teamContext = features?.teamContext ?? {};
  const parkFactor = toNumber(features?.park?.factor ?? features?.parkFactor);
  const expectedPA = toNumber(features?.expectedPA);
  const battingOrder = toNumber(features?.battingOrder);
  const powerScore = toNumber(derived?.PowerScore ?? features?.power_score);
  const matchupScore = toNumber(derived?.MatchupScore ?? features?.matchup_score);
  const opportunityScore = toNumber(derived?.OpportunityScore ?? features?.opportunity_score);
  const recentForm = toNumber(derived?.RecentForm);
  const seasonPA = toNumber(season?.pa);
  const hrRate = seasonPA != null && seasonPA > 0 ? Number(season?.home_runs ?? 0) / seasonPA : null;
  const recentAvg = toNumber(recent?.avg);
  const seasonAvg = toNumber(season?.avg);
  const projectedCount = toNumber(prediction?.projection);

  if (
    (powerScore != null && powerScore >= DRIVER_THRESHOLDS.elitePowerScore) ||
    (hrRate != null && hrRate >= DRIVER_THRESHOLDS.eliteHrRate)
  ) {
    drivers.push("Elite Power");
  }
  if (matchupScore != null && matchupScore >= DRIVER_THRESHOLDS.strongMatchupScore) {
    drivers.push("Strong Matchup");
  }
  if (parkFactor != null && parkFactor >= DRIVER_THRESHOLDS.favorableParkFactor) {
    drivers.push("Favorable Ballpark");
  }
  if (
    (expectedPA != null && expectedPA >= DRIVER_THRESHOLDS.highExpectedPA) ||
    (battingOrder != null && battingOrder <= DRIVER_THRESHOLDS.premiumBattingOrder)
  ) {
    drivers.push("High Expected PA");
  }
  if (
    (recentForm != null && recentForm >= DRIVER_THRESHOLDS.strongRecentForm) ||
    (recentAvg != null && seasonAvg != null && recentAvg - seasonAvg >= DRIVER_THRESHOLDS.hotStreakDeltaAvg)
  ) {
    drivers.push("Recent Hot Streak");
  }
  if (
    (opportunityScore != null && opportunityScore >= DRIVER_THRESHOLDS.strongOpportunityScore) ||
    (toNumber(teamContext?.runsPerGame) ?? 0) >= DRIVER_THRESHOLDS.strongRunEnvironment
  ) {
    drivers.push("Strong Run Environment");
  }
  if (prediction?.player_type === "pitcher" && projectedCount != null && projectedCount >= 5.5) {
    drivers.push("Strikeout Upside");
  }

  return drivers.slice(0, 5);
}

function getRecommendationDrivers(prediction, features = {}) {
  const explicit = Array.isArray(features?.recommendationReasons)
    ? features.recommendationReasons.map(normalizeDriverLabel).filter(Boolean)
    : [];
  const inferred = inferRecommendationDrivers(prediction, features);
  const merged = [...explicit, ...inferred];
  const unique = Array.from(new Set(merged));
  return unique.length ? unique.slice(0, 5) : ["Balanced Projection"];
}

function getIndependentConfidence(prediction, features = {}, modelProbability = null) {
  const storedConfidence = toNumber(features?.confidenceScore);
  if (
    storedConfidence != null &&
    modelProbability != null &&
    Math.abs(storedConfidence / 100 - modelProbability) > CONFIDENCE_DIVERGENCE_THRESHOLD
  ) {
    return clamp(Math.round(storedConfidence), 0, 100);
  }

  const dataQuality = normalizeDataQuality(prediction?.data_quality).key;
  const qualityScore = QUALITY_SCORES[dataQuality] ?? QUALITY_SCORES.limited;

  const season = features?.season ?? {};
  const recent = features?.recent ?? {};
  const split = features?.split ?? {};
  const completenessSignals = [
    season && Object.keys(season).length > 0,
    recent && Object.keys(recent).length > 0,
    split && Object.keys(split).length > 0,
    features?.opponentPitcher && Object.keys(features.opponentPitcher).length > 0,
    features?.derivedFeatures && Object.keys(features.derivedFeatures).length > 0,
    hasNumber(features?.expectedPA) || hasNumber(features?.expectedIP),
    hasNumber(features?.battingOrder),
  ];
  const completenessScore = (completenessSignals.filter(Boolean).length / completenessSignals.length) * 100;

  const seasonSample = toNumber(season?.pa ?? season?.bf) ?? 0;
  const recentSample = toNumber(recent?.pa) ?? 0;
  const pitcherSample = toNumber(features?.opponentPitcher?.bf ?? features?.opponentPitcher?.ip) ?? 0;
  const sampleScore = (
    clamp(seasonSample / SAMPLE_THRESHOLDS.season, 0, 1) * SAMPLE_WEIGHTS.season +
    clamp(recentSample / SAMPLE_THRESHOLDS.recent, 0, 1) * SAMPLE_WEIGHTS.recent +
    clamp(pitcherSample / SAMPLE_THRESHOLDS.pitcher, 0, 1) * SAMPLE_WEIGHTS.pitcher
  ) * 100;

  // Baseline assumes partially uncertain lineup context when order/usage is missing.
  let lineupCertainty = 58;
  const battingOrder = toNumber(features?.battingOrder);
  if (prediction?.player_type === "pitcher") {
    lineupCertainty = hasNumber(features?.expectedIP) ? 72 : 60;
  } else if (battingOrder != null) {
    lineupCertainty = clamp(82 - (battingOrder - 1) * 4, 58, 84);
  }

  const pitcherCertainty = prediction?.player_type === "pitcher"
    ? (hasNumber(features?.opponentTeam?.k_percent) ? 74 : 62)
    : (features?.opponentPitcher && Object.keys(features.opponentPitcher).length > 0 ? 76 : 60);

  const floor = toNumber(prediction?.floor);
  const ceiling = toNumber(prediction?.ceiling);
  const bandWidth = floor != null && ceiling != null ? Math.max(0, ceiling - floor) : null;
  // An approximately 45% floor/ceiling spread represents a very wide uncertainty band.
  const consistencyScore = bandWidth == null ? 64 : clamp((1 - bandWidth / 0.45) * 100, 42, 86);

  const score = (
    qualityScore * CONFIDENCE_COMPONENT_WEIGHTS.quality +
    completenessScore * CONFIDENCE_COMPONENT_WEIGHTS.completeness +
    sampleScore * CONFIDENCE_COMPONENT_WEIGHTS.sample +
    lineupCertainty * CONFIDENCE_COMPONENT_WEIGHTS.lineup +
    pitcherCertainty * CONFIDENCE_COMPONENT_WEIGHTS.pitcher +
    consistencyScore * CONFIDENCE_COMPONENT_WEIGHTS.consistency
  );
  return clamp(Math.round(score), 0, 100);
}

export {
  getIndependentConfidence,
  getRecommendationDrivers,
  normalizeDataQuality,
  toPercentLabel,
};
