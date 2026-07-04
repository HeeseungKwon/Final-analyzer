import { TableRow, TableCell } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { ChevronDown, ChevronUp } from "lucide-react";

const MARKET_SHORT = {
  hit_1: "1+ Hit",
  hit_2: "2+ Hits",
  hrr: "HRR",
  total_bases: "Total Bases",
  home_run: "Home Run",
  strikeouts: "Strikeouts",
};

function fmt(n, digits = 2) {
  const v = Number(n);
  if (!isFinite(v)) return "—";
  return v.toFixed(digits);
}

function confidenceColor(c) {
  if (c >= 70) return "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400";
  if (c >= 50) return "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400";
  return "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400";
}

export default function PredRow({ p, expanded, onToggle }) {
  let features = {};
  try {
    features = typeof p.features === "string" ? JSON.parse(p.features) : (p.features || {});
  } catch {}

  return (
    <>
      <TableRow
        className="cursor-pointer hover:bg-muted/50 transition-colors"
        onClick={onToggle}
      >
        <TableCell className="font-medium">
          <div className="flex items-center gap-2">
            {p.player_name}
            {p.player_type === "pitcher" && (
              <Badge variant="outline" className="text-[10px] px-1.5 py-0">SP</Badge>
            )}
          </div>
        </TableCell>
        <TableCell>{MARKET_SHORT[p.market] ?? p.market}</TableCell>
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
            {p.verdict === "strong" && p.market === "home_run" && (
              <Badge variant="outline" className="border-emerald-500 text-emerald-600 text-[10px]">STRONG</Badge>
            )}
            {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          </div>
        </TableCell>
      </TableRow>
      {expanded && (
        <TableRow className="bg-muted/30">
          <TableCell colSpan={6}>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 py-2 text-xs">
              <div>
                <div className="text-muted-foreground">Floor</div>
                <div className="font-semibold tabular-nums">{fmt(p.floor, 3)}</div>
              </div>
              <div>
                <div className="text-muted-foreground">Ceiling</div>
                <div className="font-semibold tabular-nums">{fmt(p.ceiling, 3)}</div>
              </div>
              <div>
                <div className="text-muted-foreground">Trigger strength</div>
                <div className="font-semibold tabular-nums">{fmt(p.trigger_strength, 2)}</div>
              </div>
              <div>
                <div className="text-muted-foreground">Rec Score</div>
                <div className="font-semibold tabular-nums">{fmt(p.rec_score, 1)}</div>
              </div>
              <div>
                <div className="text-muted-foreground">Data quality</div>
                <div className="font-semibold">{p.data_quality}</div>
              </div>
              {p.verdict && (
                <div>
                  <div className="text-muted-foreground">Verdict</div>
                  <div className="font-semibold">{p.verdict}</div>
                </div>
              )}
            </div>
            {p.verdict_note && (
              <div className="mt-1 text-xs text-muted-foreground border-t border-border/40 pt-2">
                {p.verdict_note}
              </div>
            )}
            {Object.keys(features).length > 0 && (
              <div className="mt-2 border-t border-border/40 pt-2">
                <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1">Features</div>
                <div className="flex flex-wrap gap-2 text-xs">
                  {Object.entries(features).map(([k, v]) => (
                    <span key={k} className="rounded bg-muted px-2 py-0.5">
                      <span className="text-muted-foreground">{k}:</span>{" "}
                      <span className="font-medium tabular-nums">{typeof v === "number" ? v.toFixed(3) : String(v ?? "—")}</span>
                    </span>
                  ))}
                </div>
              </div>
            )}
          </TableCell>
        </TableRow>
      )}
    </>
  );
}