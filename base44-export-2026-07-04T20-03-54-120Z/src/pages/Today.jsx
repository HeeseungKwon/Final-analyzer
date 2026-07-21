const db = globalThis.__B44_DB__ || { auth:{ isAuthenticated: async()=>false, me: async()=>null }, entities:new Proxy({}, { get:()=>({ filter:async()=>[], get:async()=>null, create:async()=>({}), update:async()=>({}), delete:async()=>({}) }) }), integrations:{ Core:{ UploadFile:async()=>({ file_url:'' }) } } };

import React, { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

import AppShell from "@/components/mlb/AppShell";
import PredRow from "@/components/mlb/PredRow";
import RecommendationsDisplay from "@/components/mlb/RecommendationsDisplay";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ChevronDown, ChevronUp, RefreshCw, Database } from "lucide-react";
import { runAnalysis } from "@/lib/analysis-runner";
import { getSnapshotMeta, refreshSnapshot } from "@/lib/sportsbook-api";
import { useToast } from "@/components/ui/use-toast";
import { MARKETS_FOR_FILTERS, getMarketProjectionUnit } from "@/lib/constants/markets";

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function isFinalGameStatus(status) {
  const s = String(status ?? "").toLowerCase();
  return s.includes("final") || s.includes("game over") || s.includes("completed");
}

function getTodayProjectionLabel(market) {
  const labels = {
    hit_2: "Exp. Hits",
    total_bases: "Exp. TB",
    hrr_2: "Exp. HRR",
    hrr_3: "Exp. HRR",
  };
  return labels[market] ?? getMarketProjectionUnit(market)?.label;
}

function getTodayProjectionDescription(market) {
  const descriptions = {
    hit_2: "Proj = model-estimated hits count (not P(2+ hits)).",
    total_bases: "Proj = model-estimated total bases count (not P(TB ≥ 2)).",
    hrr_2: "Proj = model-estimated hits + runs + RBIs count (not P(HRR ≥ 2)).",
    hrr_3: "Proj = model-estimated hits + runs + RBIs count (not P(HRR ≥ 3)).",
  };
  return descriptions[market] ?? null;
}

export default function Today() {
  const [date, setDate] = useState(todayStr());
  const [market, setMarket] = useState("all");
  const [onlyRec, setOnlyRec] = useState(false);
  const [expanded, setExpanded] = useState({});
  const [collapsedGames, setCollapsedGames] = useState({});
  const [progress, setProgress] = useState("");
  const [refreshOdds, setRefreshOdds] = useState(false);
  const [snapshotMeta, setSnapshotMeta] = useState(null);
  const { toast } = useToast();
  const qc = useQueryClient();

  // Load snapshot metadata whenever the date changes or after a refresh
  useEffect(() => {
    setSnapshotMeta(getSnapshotMeta(date));
  }, [date]);

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
    mutationFn: () => runAnalysis(date, setProgress, { refreshOdds }),
    onSuccess: (r) => {
      toast({ title: "Analysis complete", description: r.message });
      setProgress("");
      // Reload snapshot metadata after run (it may have been populated/refreshed)
      setSnapshotMeta(getSnapshotMeta(date));
      // Reset the refresh toggle back to OFF after a manual refresh run
      if (refreshOdds) setRefreshOdds(false);
      qc.invalidateQueries({ queryKey: ["predictions", date] });
    },
    onError: (e) => {
      toast({ title: "Error", description: String(e?.message ?? e), variant: "destructive" });
      setProgress("");
    },
  });

  function handleRefreshOddsNow() {
    refreshSnapshot(date);
    setSnapshotMeta(null);
    setRefreshOdds(true);
    toast({ title: "Snapshot cleared", description: "Fresh sportsbook odds will be downloaded on the next analysis run." });
  }

  const games = data?.games ?? [];
  const finalGamePks = new Set(
    games.filter((g) => isFinalGameStatus(g.status)).map((g) => g.game_pk)
  );
  const recommendationPredictions = (data?.predictions ?? []).filter((p) => {
    // Exclude recommendations from games that are already final.
    if (p.recommended && finalGamePks.has(p.game_pk)) return false;
    return true;
  });

  const predictions = recommendationPredictions.filter((p) => {
    if (Number(p.projection ?? 0) < 0.60) return false;
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
            Every projected hitter and starting pitcher is now compared against market implied odds. Picks where our model probability exceeds the market implied probability (edge {'>'} 0) are recommended.
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-40" />
          <Button onClick={() => run.mutate()} disabled={run.isPending}>
            {run.isPending ? "Analyzing…" : "Run analysis"}
          </Button>
        </div>
      </div>

      {/* ── Sportsbook Snapshot Section ─────────────────────────────────── */}
      <Card className="mb-6">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm font-semibold">
            <Database className="h-4 w-4 text-muted-foreground" />
            Sportsbook Odds Snapshot
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-start justify-between gap-4">
            {/* Snapshot info */}
            <div className="grid grid-cols-2 gap-x-8 gap-y-1 text-sm">
              <span className="text-muted-foreground">Snapshot date</span>
              <span className="font-medium">{snapshotMeta?.date ?? "—"}</span>
              <span className="text-muted-foreground">First fetched</span>
              <span className="font-medium">
                {snapshotMeta?.fetchedAt
                  ? new Date(snapshotMeta.fetchedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
                  : "—"}
              </span>
              <span className="text-muted-foreground">Last updated</span>
              <span className="font-medium">
                {snapshotMeta?.lastUpdatedAt
                  ? new Date(snapshotMeta.lastUpdatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
                  : "—"}
              </span>
              <span className="text-muted-foreground">Sportsbooks</span>
              <span className="font-medium">
                {snapshotMeta?.sportsbooks?.length
                  ? snapshotMeta.sportsbooks.join(", ")
                  : "—"}
              </span>
            </div>

            {/* Refresh controls */}
            <div className="flex flex-col items-end gap-3">
              <div className="flex items-center gap-2">
                <Switch
                  id="refresh-odds-toggle"
                  checked={refreshOdds}
                  onCheckedChange={setRefreshOdds}
                />
                <Label htmlFor="refresh-odds-toggle" className="text-sm cursor-pointer">
                  Refresh odds on next run
                </Label>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="gap-2"
                onClick={handleRefreshOddsNow}
                disabled={run.isPending}
              >
                <RefreshCw className="h-3 w-3" />
                Refresh Today's Sportsbook Odds
              </Button>
              <p className="text-xs text-muted-foreground text-right max-w-xs">
                {snapshotMeta
                  ? "Using cached snapshot. Toggle on or click refresh to download fresh odds."
                  : "No snapshot for this date. Odds will be fetched when you run analysis."}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {run.isPending && progress && (
        <div className="mb-4 rounded border bg-muted/40 px-3 py-2 text-xs text-muted-foreground animate-pulse">
          {progress}
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Tabs value={market} onValueChange={setMarket}>
          <TabsList>
            {MARKETS_FOR_FILTERS.map((m) => (
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

      {/* Market-Specific Recommendations Display (when viewing all markets) */}
      {market === "all" && !isLoading && predictions.length > 0 && (
        <div className="mb-8">
          <RecommendationsDisplay predictions={recommendationPredictions} title="Market-Specific Recommendations" />
        </div>
      )}

      {market !== "all" && getMarketProjectionUnit(market) && (
        <div className="mb-4 rounded border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <b className="text-foreground">Proj</b> = {getTodayProjectionLabel(market)} —{" "}
          {getTodayProjectionDescription(market) ?? getMarketProjectionUnit(market).description}{" "}
          {getTodayProjectionDescription(market)
            ? "Values are expected counts."
            : getMarketProjectionUnit(market).unit === "probability"
              ? "Values are 0.000–1.000 (multiply by 100 for %)."
              : "Values are expected counts."}{" "}
          <b className="text-foreground">Floor</b> / <b className="text-foreground">Ceiling</b> still show model probability bands in expanded details. Picks are recommended when our model probability exceeds market implied probability (edge {'>'} 0).
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
            const gameKey = String(g.game_pk ?? g.id);
            const isGameCollapsed = !!collapsedGames[gameKey];
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
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary">{g.status}</Badge>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-8 gap-1 px-2 text-xs"
                      aria-expanded={!isGameCollapsed}
                      aria-controls={`game-picks-${gameKey}`}
                      onClick={() => setCollapsedGames((prev) => ({ ...prev, [gameKey]: !prev[gameKey] }))}
                    >
                      {isGameCollapsed ? (
                        <>
                          <ChevronDown className="h-3 w-3" />
                          펼치기
                        </>
                      ) : (
                        <>
                          <ChevronUp className="h-3 w-3" />
                          접기
                        </>
                      )}
                    </Button>
                  </div>
                </CardHeader>
                <CardContent id={`game-picks-${gameKey}`} className={isGameCollapsed ? "hidden" : undefined}>
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
                              Proj{market !== "all" && getTodayProjectionLabel(market) ? ` (${getTodayProjectionLabel(market)})` : ""}
                             </TableHead>
                             <TableHead>Trigger</TableHead>
                            <TableHead className="text-right">Edge / Rec</TableHead>
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
