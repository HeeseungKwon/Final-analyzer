/**
 * Pick Grade Helper
 *
 * Computes a per-pick numeric grade and letter grade from existing scoring signals.
 *
 * Formula (documented):
 *   gradeScore = clamp(0.60 * rec_score + 0.40 * confidence, 0, 100)
 *
 *   The 60/40 split weights the holistic rec_score (which already blends
 *   model probability, legacy consensus, trigger strength, certainty, and
 *   market-reliability signals) more heavily than raw confidence, which is
 *   a single-factor probability mapping. This produces stable ordering
 *   without wild swings from small confidence differences.
 *
 * Grade mapping:
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

  const gradeScore = clamp(0.60 * r + 0.40 * c, 0, 100);

  let letterGrade;
  if (gradeScore >= 85) {
    letterGrade = "S";
  } else if (gradeScore >= 72) {
    letterGrade = "A";
  } else if (gradeScore >= 60) {
    letterGrade = "B";
  } else if (gradeScore >= 48) {
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
