import React from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";

const MARKET_LABEL = {
  hit_1: "1+ Hit",
  hit_2: "2+ Hits",
  hrr: "HRR",
  total_bases: "Total Bases",
  home_run: "Home Run",
  strikeouts: "Strikeouts",
};

export default function PicksReviewTable({ picks }) {
  if (!picks || picks.length === 0) {
    return <div className="py-8 text-center text-sm text-muted-foreground">No graded picks yet.</div>;
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Date</TableHead>
          <TableHead>Player</TableHead>
          <TableHead>Market</TableHead>
          <TableHead className="text-right">Confidence</TableHead>
          <TableHead className="text-right">Result</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {picks.map((p) => (
          <TableRow key={p.id}>
            <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{p.game_date}</TableCell>
            <TableCell className="font-medium">{p.player_name}</TableCell>
            <TableCell>{MARKET_LABEL[p.market] ?? p.market}</TableCell>
            <TableCell className="text-right tabular-nums">{p.confidence != null ? Math.round(p.confidence) : "—"}</TableCell>
            <TableCell className="text-right">
              {p.hit ? (
                <Badge className="bg-emerald-100 text-emerald-800 hover:bg-emerald-100">Correct</Badge>
              ) : (
                <Badge className="bg-rose-100 text-rose-800 hover:bg-rose-100">Wrong</Badge>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}