/**
 * Pick Grade Helper
 *
 * Computes a per-pick numeric grade and letter grade from existing scoring signals.
 *
 * Formula (documented):
 *   gradeScore = clamp(REC_SCORE_WEIGHT × rec_score + CONFIDENCE_WEIGHT × confidence, 0, 100)
 *
 *   The 60/40 split weights the holistic rec_score (which already blends
 *   model probability, legacy consensus, trigger strength, certainty, and
 *   market-reliability signals) more heavily than raw confidence, which is
 *   a single-factor probability mapping. This produces stable ordering
 *   without wild swings from small confidence differences.
 *
 * Grade mapping (based on gradeScore):
 *   S  ≥ 85 — elite picks; model & consensus strongly aligned, high edge
 *   A  ≥ 72 — strong picks; well above threshold, reliable signal
 *   B  ≥ 60 — solid picks; above threshold with decent margin
 *   C  ≥ 48 — borderline picks; near-threshold, proceed with caution
 *   D  < 48 — weak picks; below recommended threshold
 *
 * Safe defaults: returns { numericGrade: 0, letterGrade: "D" } when inputs
 * are missing or non-numeric so no runtime errors are introduced in UI code.
 */

/** @param {number} x @param {number} lo @param {number} hi */
function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

// Blend weights for gradeScore formula (must sum to 1.0).
// rec_score captures multi-signal consensus; confidence captures single-factor probability.
const REC_SCORE_WEIGHT = 0.60;
const CONFIDENCE_WEIGHT = 0.40;

// Grade thresholds applied to gradeScore (0–100).
// Boundaries chosen to align with the analyzer's quality tiers (tier s/a/b/c/d
// from tierForPrediction) and the consensus thresholds in analysis-runner.js.
const GRADE_THRESHOLDS = {
  S: 85, // tier "s" equivalent – top-tier edge signal
  A: 72, // tier "a" equivalent – strong recommendation
  B: 60, // tier "b" equivalent – solid pick above threshold
  C: 48, // tier "c" equivalent – borderline / near-threshold
  // D: everything below C
};

/**
 * Compute grade for a single pick object.
 *
 * @param {Object} pick - Prediction row; uses rec_score and confidence fields.
 * @returns {{ numericGrade: number, letterGrade: string }}
 */
export function computePickGrade(pick) {
  const recScore = Number(pick?.rec_score ?? pick?.recScore ?? 0);
  const confidence = Number(pick?.confidence ?? 0);

  const r = Number.isFinite(recScore) ? recScore : 0;
  const c = Number.isFinite(confidence) ? confidence : 0;

  const gradeScore = clamp(REC_SCORE_WEIGHT * r + CONFIDENCE_WEIGHT * c, 0, 100);

  let letterGrade;
  if (gradeScore >= GRADE_THRESHOLDS.S) {
    letterGrade = "S";
  } else if (gradeScore >= GRADE_THRESHOLDS.A) {
    letterGrade = "A";
  } else if (gradeScore >= GRADE_THRESHOLDS.B) {
    letterGrade = "B";
  } else if (gradeScore >= GRADE_THRESHOLDS.C) {
    letterGrade = "C";
  } else {
    letterGrade = "D";
  }

  return { numericGrade: Math.round(gradeScore * 10) / 10, letterGrade };
}

/**
 * CSS class string for a letter grade badge, suitable for Tailwind.
 *
 * @param {string} letterGrade - One of S, A, B, C, D
 * @returns {string} Tailwind class string
 */
export function gradeColorClass(letterGrade) {
  switch (letterGrade) {
    case "S":
      return "bg-violet-600 text-white";
    case "A":
      return "bg-emerald-600 text-white";
    case "B":
      return "bg-blue-500 text-white";
    case "C":
      return "bg-amber-500 text-white";
    case "D":
    default:
      return "bg-muted text-muted-foreground";
  }
}
