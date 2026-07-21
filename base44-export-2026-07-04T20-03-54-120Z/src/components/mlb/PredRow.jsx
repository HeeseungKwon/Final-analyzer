import { TableRow, TableCell } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { ChevronDown, ChevronUp } from "lucide-react";
import { getMarketLabel } from "@/lib/constants/markets";

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

function fmtPct(n, digits = 1) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  return `${(v * 100).toFixed(digits)}%`;
}

function fmtAmerican(odds) {
  const value = Number(odds);
  if (!Number.isFinite(value) || value === 0) return "—";
  return value > 0 ? `+${value}` : `${value}`;
}

function formatOddsFallbackReason(reason) {
  const labels = {
    "api-key-missing": "RapidAPI key not configured",
    "rapidapi-not-configured": "RapidAPI key not configured",
    "missing-params": "Missing game data",
    "no-match": "No sportsbook match",
  };
  return labels[reason] ?? reason;
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
  const projectionValue = Number(p.projection);
  const modelProb = Number.isFinite(Number(features?.modelProbability))
    ? Number(features.modelProbability)
    : (p.market !== "strikeouts" && projectionValue >= 0 && projectionValue <= 1 ? projectionValue : null);
  const impliedProb = features?.impliedProbability ?? features?.impliedMarketProb ?? null;
  const marketOdds = features?.marketOdds ?? null;
  const edge = features?.edge ?? features?.modelEdge ?? null;
  const roi = features?.roi ?? null;
  const expectedValue = features?.expectedValue ?? null;
  const kellyFraction = features?.kellyFraction ?? null;
  const recommendedStake = features?.recommendedStake ?? null;
  const marketLine = features?.marketLine ?? null;
  const oddsSource = features?.oddsSource ?? null;
  const oddsProvider = features?.sportsbookProvider ?? null;
  const oddsFallback = features?.oddsFallback ?? null;
  const oddsFallbackReason = features?.oddsFallbackReason ?? null;
  const oddsStatusReason = oddsFallbackReason ? formatOddsFallbackReason(oddsFallbackReason) : null;
  const tbOver15Prob = features?.tbOver1_5Prob;
  const hrrOver15Prob = features?.hrrOver1_5Prob;
  const hrrOver25Prob = features?.hrrOver2_5Prob;
  const recommendationReasons = Array.isArray(features?.recommendationReasons) ? features.recommendationReasons : [];

  const confidence = Number(p.confidence ?? 0);

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
                  <div className="text-muted-foreground">Floor</div>
                  <div className="font-semibold tabular-nums">{fmt(p.floor, 3)}</div>
                </div>
                <div>
                  <div className="text-muted-foreground">Ceiling</div>
                  <div className="font-semibold tabular-nums">{fmt(p.ceiling, 3)}</div>
                </div>
                <div>
                  <div className="text-muted-foreground">Trigger</div>
                  <div className="font-semibold tabular-nums">{fmt(p.trigger_strength, 2)}</div>
                </div>
                <div>
                  <div className="text-muted-foreground">Data Quality</div>
                  <div className="font-semibold">{p.data_quality}</div>
                </div>
              </div>

              {(modelProb != null || impliedProb != null || marketOdds != null) && (
                <div className="border-t border-border/40 pt-2">
                  <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-2">Market vs Model</div>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-xs">
                    <div>
                      <div className="text-muted-foreground">Implied Probability</div>
                      <div className="font-semibold tabular-nums">{fmtPct(impliedProb)}</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground">Model Probability</div>
                      <div className="font-semibold tabular-nums">{fmtPct(modelProb)}</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground">Odds Source</div>
                      <div className="font-semibold">{oddsProvider ?? oddsSource ?? "—"}</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground">Odds Status</div>
                      <div className="font-semibold">
                        {oddsFallback ? `Fallback${oddsStatusReason ? ` (${oddsStatusReason})` : ""}` : "Live"}
                      </div>
                    </div>
                    <div>
                      <div className="text-muted-foreground">EV (1u stake)</div>
                      <div className="font-semibold tabular-nums">{oddsFallback ? "N/A" : fmt(expectedValue, 3)}</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground">ROI</div>
                      <div className="font-semibold tabular-nums">{oddsFallback ? "N/A" : Number.isFinite(Number(roi)) ? `${Number(roi).toFixed(1)}%` : "—"}</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground">Kelly / Stake</div>
                      <div className="font-semibold tabular-nums">
                        {oddsFallback ? "N/A" : `${fmtPct(kellyFraction)} / ${fmtPct(recommendedStake)}`}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {p.verdict && (
                <div className="border-t border-border/40 pt-2">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-muted-foreground">Status:</span>
                    <Badge variant="outline" className={"text-[10px] " + verdictColor(p.verdict)}>
                      {p.verdict.toUpperCase()}
                    </Badge>
                  </div>
                </div>
              )}

              {p.verdict_note && (
                <div className="border-t border-border/40 pt-2">
                  <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1">Verdict Note</div>
                  <div className="text-xs text-muted-foreground leading-relaxed">{p.verdict_note}</div>
                </div>
              )}

              {recommendationReasons.length > 0 && (
                <div className="border-t border-border/40 pt-2">
                  <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1">Recommendation Drivers</div>
                  <div className="flex flex-wrap gap-2 text-xs">
                    {recommendationReasons.map((reason) => (
                      <span key={reason} className="rounded bg-muted px-2 py-0.5 font-medium">{reason}</span>
                    ))}
                  </div>
                </div>
              )}

              {/* Feature Breakdown */}
              {Object.keys(features).length > 0 && (
                <div className="border-t border-border/40 pt-2">
                  <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1">Features</div>
                  <div className="flex flex-wrap gap-2 text-xs">
                    {Object.entries(features)
                      .filter(([k, v]) => !["verdict", "verdictNote", "recommendationReasons", "recommendationComponents"].includes(k) && (v == null || typeof v !== "object"))
                      .map(([k, v]) => (
                        <span key={k} className="rounded bg-muted px-2 py-0.5">
                          <span className="text-muted-foreground">{k}:</span>{" "}
                          <span className="font-medium tabular-nums">{typeof v === "number" ? v.toFixed(3) : String(v ?? "—")}</span>
                        </span>
                      ))}
                  </div>
                </div>
              )}

              {(p.market === "total_bases" && tbOver15Prob != null) ||
              (p.market === "hrr_2" && hrrOver15Prob != null) ||
              (p.market === "hrr_3" && hrrOver25Prob != null) ? (
                <div className="border-t border-border/40 pt-2">
                  <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-2">Line Probabilities</div>
                  <div className="space-y-1 text-xs">
                    {p.market === "total_bases" && tbOver15Prob != null && (
                      <div className="flex justify-between items-center">
                        <span className="text-muted-foreground">TB O1.5:</span>
                        <span className="font-semibold tabular-nums">{fmt(tbOver15Prob * 100, 1)}%</span>
                      </div>
                    )}
                    {p.market === "hrr_2" && hrrOver15Prob != null && (
                      <div className="flex justify-between items-center">
                        <span className="text-muted-foreground">HRR O1.5:</span>
                        <span className="font-semibold tabular-nums">{fmt(hrrOver15Prob * 100, 1)}%</span>
                      </div>
                    )}
                    {p.market === "hrr_3" && hrrOver25Prob != null && (
                      <div className="flex justify-between items-center">
                        <span className="text-muted-foreground">HRR O2.5:</span>
                        <span className="font-semibold tabular-nums">{fmt(hrrOver25Prob * 100, 1)}%</span>
                      </div>
                    )}
                  </div>
                </div>
              ) : null}
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}
