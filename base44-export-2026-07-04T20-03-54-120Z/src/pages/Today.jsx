const db = globalThis.__B44_DB__ || { auth:{ isAuthenticated: async()=>false, me: async()=>null }, entities:new Proxy({}, { get:()=>({ filter:async()=>[], get:async()=>null, create:async()=>({}), update:async()=>({}), delete:async()=>({}) }) }), integrations:{ Core:{ UploadFile:async()=>({ file_url:'' }) } } };

import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

import AppShell from "@/components/mlb/AppShell";
import PredRow from "@/components/mlb/PredRow";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { runAnalysis } from "@/lib/analysis-runner";
import { useToast } from "@/components/ui/use-toast";

const MARKETS = [
  { key: "all", label: "All" },
  { key: "hit_1", label: "1+ Hit" },
  { key: "hit_2", label: "2+ Hits" },
  { key: "hrr", label: "HRR" },
  { key: "total_bases", label: "Total Bases" },
  { key: "home_run", label: "Home Run" },
  { key: "strikeouts", label: "Strikeouts" },
];

const PROJECTION_UNITS = {
  hit_1: { label: "P(1+ hit)", unit: "probability", description: "Probability of ≥1 hit." },
  hit_2: { label: "P(2+ hits)", unit: "probability", description: "Probability of ≥2 hits." },
  home_run: { label: "P(HR)", unit: "probability", description: "Probability of ≥1 home run." },
  total_bases: { label: "Exp. total bases", unit: "count", description: "Expected total bases (line 1.5)." },
  hrr: { label: "Exp. H+R+RBI", unit: "count", description: "Expected Hits+Runs+RBIs (line 1.5)." },
  strikeouts: { label: "Exp. K", unit: "count", description: "Expected strikeouts for the pitcher (line 5.5)." },
};

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function Today() {
  const [date, setDate] = useState(todayStr());
  const [market, setMarket] = useState("all");
  const [onlyRec, setOnlyRec] = useState(false);
  const [expanded, setExpanded] = useState({});
  const [progress, setProgress] = useState("");
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ["predictions", date],
    queryFn: async () => {
      const [games, predictions] = await Promise.all([
        db.entities.Game.filter({ game_date: date }),
        db.entities.Prediction.filter({ game_date: date }),
      ]);
      return { games, predictions };
    },
  });

  const run = useMutation({
    mutationFn: () => runAnalysis(date, setProgress),
    onSuccess: (r) => {
      toast({ title: "Analysis complete", description: r.message });
      setProgress("");
      qc.invalidateQueries({ queryKey: ["predictions", date] });
    },
    onError: (e) => {
      toast({ title: "Error", description: String(e?.message ?? e), variant: "destructive" });
      setProgress("");
    },
  });

  const games = data?.games ?? [];
  const predictions = (data?.predictions ?? []).filter((p) => {
    if (market !== "all" && p.market !== market) return false;
    if (onlyRec && !p.recommended) return false;
    return true;
  });

  return (
    <AppShell>
      <div className="mb-6 flex flex-wrap items-end gap-3">
        <div>
          <div className="text-xs uppercase tracking-widest text-muted-foreground">Slate</div>
          <h1 className="text-3xl font-black tracking-tight">Today's projections</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Every projected hitter and starting pitcher scored on the same pipeline. Confidence, floor, ceiling, and the trigger behind each pick.
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-40" />
          <Button onClick={() => run.mutate()} disabled={run.isPending}>
            {run.isPending ? "Analyzing…" : "Run analysis"}
          </Button>
        </div>
      </div>

      {run.isPending && progress && (
        <div className="mb-4 rounded border bg-muted/40 px-3 py-2 text-xs text-muted-foreground animate-pulse">
          {progress}
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Tabs value={market} onValueChange={setMarket}>
          <TabsList>
            {MARKETS.map((m) => (
              <TabsTrigger key={m.key} value={m.key}>{m.label}</TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <Button variant={onlyRec ? "default" : "outline"} size="sm" onClick={() => setOnlyRec((v) => !v)}>
          {onlyRec ? "Showing recommended only" : "Show all"}
        </Button>
        <div className="ml-auto text-xs text-muted-foreground">
          {games.length} games · {predictions.length} predictions {isFetching && "· refreshing…"}
        </div>
      </div>

      {market !== "all" && PROJECTION_UNITS[market] && (
        <div className="mb-4 rounded border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <b className="text-foreground">Proj</b> = {PROJECTION_UNITS[market].label} —{" "}
          {PROJECTION_UNITS[market].description}{" "}
          {PROJECTION_UNITS[market].unit === "probability"
            ? "Values are 0.000–1.000 (multiply by 100 for %)."
            : "Values are expected counts."}{" "}
          <b className="text-foreground">Floor</b> / <b className="text-foreground">Ceiling</b> are the same unit (10th/90th-percentile band).{" "}
          <b className="text-foreground">Conf</b> is a 0–100 model confidence.{" "}
          Recommendation uses a market-specific weighting of Floor/Ceiling/Trigger — not confidence alone.
        </div>
      )}

      {isLoading && <div className="py-10 text-center text-muted-foreground">Loading…</div>}
      {!isLoading && games.length === 0 && (
        <Card>
          <CardContent className="py-10 text-center">
            <p className="text-sm text-muted-foreground">
              No games or predictions in the database for {date}. Click <b>Run analysis</b> to pull the schedule and score every projected player.
            </p>
          </CardContent>
        </Card>
      )}

      {!isLoading && games.length > 0 && (
        <div className="space-y-6">
          {games.map((g) => {
            const rowsForGame = predictions.filter((p) => p.game_pk === g.game_pk);
            if (rowsForGame.length === 0 && market !== "all") return null;
            return (
              <Card key={g.id}>
                <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
                  <CardTitle className="text-base font-bold">
                    {g.away_team_name} @ {g.home_team_name}
                    <span className="ml-3 text-xs font-normal text-muted-foreground">
                      {g.venue_name ?? ""} · {g.game_time_utc ? new Date(g.game_time_utc).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""}
                    </span>
                  </CardTitle>
                  <Badge variant="secondary">{g.status}</Badge>
                </CardHeader>
                <CardContent>
                  <div className="mb-3 flex flex-wrap gap-3 text-xs">
                    <span className="rounded bg-muted px-2 py-1"><b>{g.away_team_name}</b> SP: {g.away_probable_pitcher_name || "TBD"}</span>
                    <span className="rounded bg-muted px-2 py-1"><b>{g.home_team_name}</b> SP: {g.home_probable_pitcher_name || "TBD"}</span>
                  </div>
                  {rowsForGame.length === 0 ? (
                    <div className="py-4 text-center text-xs text-muted-foreground">No predictions match filter.</div>
                  ) : (
                    <div className="overflow-x-auto">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Player</TableHead>
                            <TableHead>Market</TableHead>
                            <TableHead className="text-right">
                              Proj{market !== "all" && PROJECTION_UNITS[market] ? ` (${PROJECTION_UNITS[market].label})` : ""}
                            </TableHead>
                            <TableHead className="text-right">Conf</TableHead>
                            <TableHead>Trigger</TableHead>
                            <TableHead className="text-right">Rec</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {rowsForGame.map((p) => (
                            <PredRow
                              key={p.id}
                              p={p}
                              expanded={!!expanded[p.id]}
                              onToggle={() => setExpanded((e) => ({ ...e, [p.id]: !e[p.id] }))}
                            />
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </AppShell>
  );
}