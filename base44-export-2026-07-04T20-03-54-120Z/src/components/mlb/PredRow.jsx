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
 * - Verdict badges for HR picks (STRONG, MIDDLING)
 * - Expandable section showing:
 *   * Floor/ceiling percentile bands
 *   * Trigger strength (matchup indicator)
 *   * Recommendation score breakdown
 *   * Data quality
 *   * Vegas vs Park probability comparison (for HR)
 *   * Multi-source evidence scoring
 * 
 * This gives users full visibility into recommendation logic:
 * - Not just confidence, but full evidence backing each pick
 * - Transparent comparison to Vegas and ballpark baselines
 * - Helps build trust in the model through explainability
 */

function fmt(n, digits = 2) {
  const v = Number(n);
  if (!isFinite(v)) return "—";
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

/**
 * Returns verdict label color for HR picks
 */
function verdictColor(verdict) {
  switch (verdict) {
    case "strong":
      return "border-emerald-500 text-emerald-600 bg-emerald-50";
    case "middling":
      return "border-blue-500 text-blue-600 bg-blue-50";
    case "fade":
      return "border-red-500 text-red-600 bg-red-50";
    default:
      return "border-muted-foreground text-muted-foreground";
  }
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
  const modelProb = p.projection;
  const vegasProb = features?.vegasHrProb ?? null;
  const parkProb = features?.parkHrProb ?? null;
  const tbOver15Prob = features?.tbOver1_5Prob;
  const hrrOver15Prob = features?.hrrOver1_5Prob;
  const hrrOver25Prob = features?.hrrOver2_5Prob;

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
        <TableCell className="text-right tabular-nums">{fmt(p.projection, 3)}</TableCell>
        <TableCell className="text-right">
          <span className={"inline-block rounded px-1.5 py-0.5 text-xs font-semibold tabular-nums " + confidenceColor(p.confidence)}>
            {fmt(p.confidence, 0)}
          </span>
        </TableCell>
        <TableCell className="text-xs text-muted-foreground max-w-[200px] truncate">{p.trigger_text}</TableCell>
        <TableCell className="text-right">
          <div className="flex items-center justify-end gap-1">
            {p.recommended && <Badge className="bg-emerald-600 hover:bg-emerald-600 text-[10px]">REC</Badge>}
            {/* HR Pick Verdicts */}
            {p.market === "home_run" && p.verdict === "strong" && (
              <Badge variant="outline" className="border-emerald-500 text-emerald-600 text-[10px]">STRONG</Badge>
            )}
            {p.market === "home_run" && p.verdict === "middling" && (
              <Badge variant="outline" className="border-blue-500 text-blue-600 text-[10px]">MIDDLING</Badge>
            )}
            {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          </div>
        </TableCell>
      </TableRow>
      {expanded && (
        <TableRow className="bg-muted/30">
          <TableCell colSpan={6}>
            <div className="space-y-4 py-2 text-xs">
              {/* Core Metrics Grid */}
              <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
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
                  <div className="text-muted-foreground">Rec Score</div>
                  <div className="font-semibold tabular-nums">{fmt(p.rec_score, 1)}</div>
                </div>
                <div>
                  <div className="text-muted-foreground">Data Quality</div>
                  <div className="font-semibold">{p.data_quality}</div>
                </div>
              </div>

              {/* Verdict & Trigger Note */}
              {p.verdict && (
                <div className="border-t border-border/40 pt-2">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-muted-foreground">Verdict:</span>
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

              {/* Multi-Source Probability Comparison (HR only) */}
              {p.market === "home_run" && (modelProb != null || vegasProb != null || parkProb != null) && (
                <div className="border-t border-border/40 pt-2">
                  <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-2">Probability Sources</div>
                  <div className="space-y-1 text-xs">
                    <div className="flex justify-between items-center">
                      <span className="text-muted-foreground">Our Model:</span>
                      <span className="font-semibold tabular-nums">{fmt(modelProb * 100, 1)}%</span>
                    </div>
                    {parkProb != null && (
                      <div className="flex justify-between items-center">
                        <span className="text-muted-foreground">Park Baseline:</span>
                        <span className="tabular-nums">{fmt(parkProb * 100, 1)}%</span>
                      </div>
                    )}
                    {vegasProb != null && (
                      <div className="flex justify-between items-center">
                        <span className="text-muted-foreground">Vegas Implied:</span>
                        <span className="tabular-nums">{fmt(vegasProb * 100, 1)}%</span>
                      </div>
                    )}
                  </div>
                  <div className="mt-2 p-1.5 bg-muted/50 rounded text-[10px] leading-relaxed">
                    {p.verdict === "strong" && (
                      <span className="text-emerald-700 dark:text-emerald-400 font-medium">✓ STRONG: Model beats both baselines</span>
                    )}
                    {p.verdict === "middling" && (
                      <span className="text-blue-700 dark:text-blue-400 font-medium">◆ MIDDLING: Model between baselines (potential hidden edge)</span>
                    )}
                    {p.verdict === "fade" && (
                      <span className="text-red-700 dark:text-red-400 font-medium">✗ FADE: Model below higher baseline</span>
                    )}
                  </div>
                </div>
              )}

              {/* Feature Breakdown */}
              {Object.keys(features).length > 0 && (
                <div className="border-t border-border/40 pt-2">
                  <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1">Features</div>
                  <div className="flex flex-wrap gap-2 text-xs">
                    {Object.entries(features)
                      .filter(([k]) => !["verdict", "verdictNote", "vegasHrProb", "parkHrProb"].includes(k))
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