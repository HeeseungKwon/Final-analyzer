import { clamp } from "@/lib/utils/math";

export const MIN_RECOMMENDED_EDGE = 0.05;
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
  const decimalOdds = americanToDecimal(americanOdds);

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
  const edgeDecimal = Number(edge) || 0;
  // Convert to percentage points for comparison (e.g., 0.05 → 5 pts)
  const edgePts = edgeDecimal * 100;
  
  if (edgePts >= 10) return "A";
  if (edgePts >= 7.5) return "B";
  if (edgePts >= 5) return "C";
  if (edgePts > 0) return "D";
  return "F";
}

export function calculateRecommendedStake(kellyFraction) {
  return clamp((Number(kellyFraction) || 0) * CONSERVATIVE_KELLY_MULTIPLIER, 0, 0.25);
}

export function shouldRecommend(edge) {
  return Number(edge) > 0;
}
