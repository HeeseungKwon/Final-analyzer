import { gradeEdge } from "@/lib/edge-calculator";

function extractEdge(pick) {
  const rawFeatures = pick?.features;
  let features = rawFeatures;

  if (typeof rawFeatures === "string") {
    try {
      features = JSON.parse(rawFeatures);
    } catch {
      features = {};
    }
  }

  const edge = Number(features?.edge ?? features?.modelEdge);
  if (Number.isFinite(edge)) return edge;

  // Compatibility fallback: the persisted `rec_score` field now stores edge in
  // percentage points (for example 6.5 for +6.5%), so convert it back to a
  // decimal edge when older UI paths only pass the top-level prediction fields.
  const recScore = Number(pick?.rec_score ?? pick?.recScore);
  return Number.isFinite(recScore) ? recScore / 100 : 0;
}

/**
 * Edge-first grade helper.
 *
 * The old recommendation score tiers are replaced with direct edge buckets:
 *   A ≥ 10 pts, B ≥ 7.5 pts, C ≥ 5 pts, D > 0 pts, F ≤ 0 pts
 */
export function computePickGrade(pick) {
  const edge = extractEdge(pick);
  const numericGrade = Math.round(edge * 1000) / 10;
  return {
    numericGrade,
    letterGrade: gradeEdge(edge),
  };
}

export function gradeColorClass(letterGrade) {
  switch (letterGrade) {
    case "A":
      return "bg-emerald-600 text-white";
    case "B":
      return "bg-blue-500 text-white";
    case "C":
      return "bg-amber-500 text-white";
    case "D":
      return "bg-slate-500 text-white";
    case "F":
    default:
      return "bg-muted text-muted-foreground";
  }
}
