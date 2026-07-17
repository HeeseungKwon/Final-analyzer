import { TableRow, TableCell } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { ChevronDown, ChevronUp } from "lucide-react";
import { getMarketLabel } from "@/lib/constants/markets";

export default function PredRow({ p, expanded, onToggle }) {
  return <>
    <TableRow className="cursor-pointer hover:bg-muted/50" onClick={onToggle}>
      <TableCell className="font-medium">{p.player_name} {p.team_name && <span className="text-xs text-muted-foreground">({p.team_name})</span>}</TableCell>
      <TableCell>{getMarketLabel(p.market, "short")}</TableCell>
      <TableCell className="text-right tabular-nums">{Number(p.projection ?? 0).toFixed(3)}</TableCell>
      <TableCell className="text-xs text-muted-foreground">{p.trigger_text}</TableCell>
      <TableCell className="text-right"><Badge variant="outline">{p.confidence ?? 0}%</Badge>{p.recommended && <Badge className="ml-1">REC</Badge>}{expanded ? <ChevronUp className="inline h-3 w-3" /> : <ChevronDown className="inline h-3 w-3" />}</TableCell>
    </TableRow>
    {expanded && <TableRow className="bg-muted/30"><TableCell colSpan={5}><div className="space-y-2 py-2 text-xs"><div>Floor: {Number(p.floor ?? 0).toFixed(3)}</div><div>Ceiling: {Number(p.ceiling ?? 0).toFixed(3)}</div><div>Data quality: {p.data_quality ?? "unknown"}</div><div>{p.verdict_note}</div></div></TableCell></TableRow>}
  </>;
}
