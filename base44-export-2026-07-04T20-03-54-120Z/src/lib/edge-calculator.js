import { clamp } from "@/lib/utils/math";

export const MIN_RECOMMENDED_EDGE = 0.05;
export const MIN_MODEL_CONFIDENCE = 50;
// Quarter Kelly keeps sizing conservative while preserving most of the
// long-run Kelly growth benefit with materially lower drawdown volatility.
export const CONSERVATIVE_KELLY_MULTIPLIER = 0.25;

export function americanToDecimal(americanOdds) {
  const odds = Number(americanOdds);
  if (!Number.isFinite(odds) || odds === 0) return null;
  return odds > 0 ? 1 + odds / 100 : 1 + 100 / Math.abs(odds);
}

export function calculateEdge(modelProb, impliedProb) {
  const model = clamp(Number(modelProb) || 0, 0, 1);
  const market = clamp(Number(impliedProb) || 0, 0, 1);
  return model - market;
}

export function calculateKelly(modelProb, decimalOdds) {
  const p = clamp(Number(modelProb) || 0, 0, 1);
  const b = Number(decimalOdds) - 1;
  if (!Number.isFinite(b) || b <= 0) return 0;

  const q = 1 - p;
  const fullKelly = ((b * p) - q) / b;
  return clamp(fullKelly, 0, 1);
}

export function calculateROI(modelProb, impliedProb, americanOdds) {
  const decimalOdds = americanToDecimal(americanOdds)
    ?? (Number(impliedProb) > 0 ? 1 / Number(impliedProb) : null);

  if (!Number.isFinite(decimalOdds) || decimalOdds <= 1) {
    return { expectedValue: 0, roi: 0, payout: 0, decimalOdds: null };
  }

  const p = clamp(Number(modelProb) || 0, 0, 1);
  const q = 1 - p;
  const payout = decimalOdds - 1;
  const expectedValue = p * payout - q;

  return {
    expectedValue,
    roi: expectedValue * 100,
    payout,
    decimalOdds,
  };
}

export function gradeEdge(edge) {
  if (edge >= 0.10) return "A";
  if (edge >= 0.075) return "B";
  if (edge >= MIN_RECOMMENDED_EDGE) return "C";
  if (edge > 0) return "D";
  return "F";
}

export function calculateRecommendedStake(kellyFraction) {
  return clamp((Number(kellyFraction) || 0) * CONSERVATIVE_KELLY_MULTIPLIER, 0, 0.25);
}

export function shouldRecommend(edge, dataQuality, confidence) {
  return (
    Number(edge) >= MIN_RECOMMENDED_EDGE &&
    (dataQuality === "ok" || dataQuality === "partial") &&
    Number(confidence) >= MIN_MODEL_CONFIDENCE
  );
}
