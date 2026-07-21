import { TableRow, TableCell } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { ChevronDown, ChevronUp } from "lucide-react";
import { getMarketLabel } from "@/lib/constants/markets";
import { getDisplayModelProbability } from "@/lib/model-probability";
import {
  getIndependentConfidence,
  getRecommendationDrivers,
  normalizeDataQuality,
  toPercentLabel,
} from "@/lib/prediction-details";

/**
 * PredRow Component
 * 
 * Displays a single prediction with expandable details.
 * 
 * Features:
 * - Confidence color-coding
 * - Edge-grade badges
 * - Expandable section showing:
 *   * Market odds and implied probability
 *   * Model probability and edge
 *   * EV / ROI / Kelly stake sizing
 *   * Floor/ceiling percentile band and data quality
 */

function fmt(n, digits = 2) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  return v.toFixed(digits);
}

/**
 * Color-codes confidence scores for visual scanning
 * Green (≥70): High confidence. Amber (50-69): Medium. Red (<50): Low.
 */
function confidenceColor(c) {
  if (c >= 70) return "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400";
  if (c >= 50) return "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400";
  return "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400";
}

function confidenceLabel(c) {
  if (c >= 70) return "High";
  if (c >= 50) return "Medium";
  return "Low";
}

/**
 * Returns verdict label color for HR picks
 */
function verdictColor(verdict) {
  switch (verdict) {
    case "strong":
    case "recommended":
      return "border-emerald-500 text-emerald-600 bg-emerald-50";
    case "middling":
    case "marginal":
      return "border-blue-500 text-blue-600 bg-blue-50";
    case "fade":
    case "avoid":
      return "border-red-500 text-red-600 bg-red-50";
    default:
      return "border-muted-foreground text-muted-foreground";
  }
}

function getCountProjectionValue(p) {
  switch (p.market) {
    case "hit_2":
      return p.expected_hits;
    case "total_bases":
      return p.expected_total_bases;
    case "hrr_2":
    case "hrr_3":
      return p.expected_hrr;
    default:
      return p.projection;
  }
}

function fmtProjection(p) {
  return fmt(getCountProjectionValue(p), 2);
}

export default function PredRow({ p, expanded, onToggle }) {
  let features = {};
  try {
    features = typeof p.features === "string" ? JSON.parse(p.features) : (p.features || {});
  } catch {}

  /**
   * Extract probability sources for display
   * Shows model vs Vegas vs ballpark comparison
   */
  const modelProb = getDisplayModelProbability({
    market: p.market,
    projection: p.projection,
    explicitModelProbability: features?.modelProbability,
  });
  const confidence = getIndependentConfidence(p, features, modelProb);
  const dataQuality = normalizeDataQuality(p.data_quality);
  const recommendationDrivers = getRecommendationDrivers(p, features);

  return (
    <>
      <TableRow
        className="cursor-pointer hover:bg-muted/50 transition-colors"
        onClick={onToggle}
      >
        <TableCell className="font-medium">
          <div className="flex items-center gap-2">
            {p.player_name}
            {p.team_name && (
              <span className="text-xs font-normal text-muted-foreground">({p.team_name})</span>
            )}
            {p.player_type === "pitcher" && (
              <Badge variant="outline" className="text-[10px] px-1.5 py-0">SP</Badge>
            )}
          </div>
        </TableCell>
        <TableCell>{getMarketLabel(p.market, "short")}</TableCell>
        <TableCell className="text-right tabular-nums">{fmtProjection(p)}</TableCell>
        <TableCell className="text-xs text-muted-foreground max-w-[200px] truncate">{p.trigger_text}</TableCell>
        <TableCell className="text-right">
          <div className="flex items-center justify-end gap-2">
            <span className={`inline-flex rounded px-2 py-0.5 text-xs font-semibold ${confidenceColor(confidence)}`}>
              {confidenceLabel(confidence)} {Math.round(confidence)}
            </span>
            {p.recommended && <Badge className="bg-emerald-600 hover:bg-emerald-600 text-[10px]">REC</Badge>}
            {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          </div>
        </TableCell>
      </TableRow>
      {expanded && (
        <TableRow className="bg-muted/30">
          <TableCell colSpan={5}>
            <div className="space-y-4 py-2 text-xs">
              {/* Core Metrics Grid */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div>
                  <div className="text-muted-foreground">Confidence</div>
                  <div className={`inline-flex rounded px-2 py-0.5 text-xs font-semibold ${confidenceColor(confidence)}`}>
                    {confidenceLabel(confidence)} {Math.round(confidence)}
                  </div>
                </div>
                <div>
                  <div className="text-muted-foreground">Projection</div>
                  <div className="font-semibold tabular-nums">
                    {fmtProjection(p)}
                    {modelProb != null ? (
                      <span className="ml-2 text-muted-foreground font-normal">
                        ({toPercentLabel(modelProb, 0)} model prob)
                      </span>
                    ) : null}
                  </div>
                </div>
                <div>
                  <div className="text-muted-foreground">Verdict</div>
                  {p.verdict ? (
                    <Badge variant="outline" className={"text-[10px] " + verdictColor(p.verdict)}>
                      {p.verdict.toUpperCase()}
                    </Badge>
                  ) : (
                    <div className="font-semibold">—</div>
                  )}
                </div>
                <div>
                  <div className="text-muted-foreground">Data Quality</div>
                  <span className={`inline-flex rounded px-2 py-0.5 text-xs font-semibold ${dataQuality.badgeClassName}`}>
                    {dataQuality.label}
                  </span>
                </div>
              </div>

              <div className="border-t border-border/40 pt-2">
                <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1">Recommendation Drivers</div>
                <div className="flex flex-wrap gap-2 text-xs">
                  {recommendationDrivers.map((reason) => (
                    <span key={reason} className="rounded bg-muted px-2 py-0.5 font-medium">{reason}</span>
                  ))}
                </div>
              </div>

              <div className="border-t border-border/40 pt-2">
                <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-2">Floor / Ceiling</div>
                <div className="grid grid-cols-2 gap-3 text-xs">
                  <div>
                    <div className="text-muted-foreground">Floor</div>
                    <div className="font-semibold tabular-nums">{toPercentLabel(p.floor, 0)}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">Ceiling</div>
                    <div className="font-semibold tabular-nums">{toPercentLabel(p.ceiling, 0)}</div>
                  </div>
                </div>
              </div>
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}
