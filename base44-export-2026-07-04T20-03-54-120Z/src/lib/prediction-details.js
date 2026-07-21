function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

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
  const hrRate = seasonPA ? Number(season?.home_runs ?? 0) / seasonPA : null;
  const recentAvg = toNumber(recent?.avg);
  const seasonAvg = toNumber(season?.avg);
  const projectedCount = toNumber(prediction?.projection);

  if ((powerScore != null && powerScore >= 0.7) || (hrRate != null && hrRate >= 0.055)) {
    drivers.push("Elite Power");
  }
  if (matchupScore != null && matchupScore >= 0.62) {
    drivers.push("Strong Matchup");
  }
  if (parkFactor != null && parkFactor >= 105) {
    drivers.push("Favorable Ballpark");
  }
  if ((expectedPA != null && expectedPA >= 4.3) || (battingOrder != null && battingOrder <= 3)) {
    drivers.push("High Expected PA");
  }
  if ((recentForm != null && recentForm >= 0.62) || (recentAvg != null && seasonAvg != null && recentAvg - seasonAvg >= 0.02)) {
    drivers.push("Recent Hot Streak");
  }
  if ((opportunityScore != null && opportunityScore >= 0.62) || (toNumber(teamContext?.runsPerGame) ?? 0) >= 4.9) {
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
  if (storedConfidence != null && modelProbability != null && Math.abs(storedConfidence / 100 - modelProbability) > 0.005) {
    return clamp(Math.round(storedConfidence), 0, 100);
  }

  const dataQuality = normalizeDataQuality(prediction?.data_quality).key;
  const qualityScore = dataQuality === "good" ? 78 : dataQuality === "partial" ? 62 : 44;

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
    clamp(seasonSample / 280, 0, 1) * 0.5 +
    clamp(recentSample / 80, 0, 1) * 0.25 +
    clamp(pitcherSample / 350, 0, 1) * 0.25
  ) * 100;

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
  const consistencyScore = bandWidth == null ? 64 : clamp((1 - bandWidth / 0.45) * 100, 42, 86);

  const score = (
    qualityScore * 0.30 +
    completenessScore * 0.20 +
    sampleScore * 0.20 +
    lineupCertainty * 0.10 +
    pitcherCertainty * 0.10 +
    consistencyScore * 0.10
  );
  return clamp(Math.round(score), 0, 100);
}

export {
  getIndependentConfidence,
  getRecommendationDrivers,
  normalizeDataQuality,
  toPercentLabel,
};
