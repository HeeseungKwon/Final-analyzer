const db = globalThis.__B44_DB__ || { auth:{ isAuthenticated: async()=>false, me: async()=>null }, entities:new Proxy({}, { get:()=>({ filter:async()=>[], get:async()=>null, create:async()=>({}), update:async()=>({}), delete:async()=>({}) }) }), integrations:{ Core:{ UploadFile:async()=>({ file_url:'' }) } } };

import React, { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

import AppShell from "@/components/mlb/AppShell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/components/ui/use-toast";
import { gradeAllUngraded } from "@/lib/grading";
import { getMarketLabel, isProbabilityMarket } from "@/lib/constants/markets";
import BucketBar from "@/components/mlb/BucketBar";
import PicksReviewTable from "@/components/mlb/PicksReviewTable";
import { recalculateParlayStatus, syncAllParlays } from "@/lib/utils/parlaySync";

const DAILY_PARLAYS_KEY = "dailyParlays_v1";

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatSavedAt(isoStr) {
  if (!isoStr) return "";
  try {
    return new Date(isoStr).toLocaleString([], {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return isoStr;
  }
}

function formatLegProjection(leg) {
  if (leg?.projection == null) return "—";
  if (isProbabilityMarket(leg.market)) {
    return `${(Number(leg.projection) * 100).toFixed(1)}%`;
  }
  return Number(leg.projection).toFixed(2);
}

function getSavedParlayStatusLabel(status) {
  switch (status) {
    case "won":
      return "Won";
    case "lost":
      return "Lost";
    case "inProgress":
      return "In Progress";
    default:
      return "Pending";
  }
}

function getLegResultLabel(result) {
  switch (result) {
    case "hit":
      return "✓ Hit";
    case "miss":
      return "✗ Miss";
    default:
      return "⊘ Pending";
  }
}

function getSavedParlayStatusClass(status) {
  switch (status) {
    case "won":
      return "bg-emerald-100 text-emerald-800 hover:bg-emerald-100";
    case "lost":
      return "bg-rose-100 text-rose-800 hover:bg-rose-100";
    case "inProgress":
      return "bg-sky-100 text-sky-800 hover:bg-sky-100";
    default:
      return "bg-yellow-100 text-yellow-800 hover:bg-yellow-100";
  }
}

function getSavedParlayLegKey(leg, legIndex) {
  return leg.predictionId ?? `${leg.playerId ?? leg.player_id ?? legIndex}-${leg.market}`;
}

function savedParlaysEqual(currentParlays, nextParlays) {
  if (currentParlays.length !== nextParlays.length) return false;

  const nextParlaysById = new Map(nextParlays.map((parlay) => [parlay.id, parlay]));

  return currentParlays.every((parlay) => {
    const nextParlay = nextParlaysById.get(parlay.id);
    if (!nextParlay) return false;
    if (
      parlay.status !== nextParlay.status ||
      parlay.completedLegs !== nextParlay.completedLegs ||
      parlay.pendingLegs !== nextParlay.pendingLegs ||
      parlay.hitLegs !== nextParlay.hitLegs ||
      parlay.missLegs !== nextParlay.missLegs ||
      parlay.totalLegs !== nextParlay.totalLegs ||
      (parlay.legs?.length ?? 0) !== (nextParlay.legs?.length ?? 0)
    ) {
      return false;
    }

    const nextLegResults = new Map((nextParlay.legs ?? []).map((leg, legIndex) => [getSavedParlayLegKey(leg, legIndex), leg.result]));
    return (parlay.legs ?? []).every((leg, legIndex) => nextLegResults.get(getSavedParlayLegKey(leg, legIndex)) === leg.result);
  });
}

function buildAccuracyFromPicks(gradedPicks) {
  const byMarket = {};
  const byBucket = {};

  for (const p of gradedPicks) {
    if (p.hit == null) continue;

    if (!byMarket[p.market]) byMarket[p.market] = { market: p.market, n: 0, hits: 0 };
    byMarket[p.market].n += 1;
    if (p.hit) byMarket[p.market].hits += 1;

    const bucket = Math.min(90, Math.max(0, Math.floor((p.confidence ?? 0) / 10) * 10));
    const key = `${p.market}_${bucket}`;
    if (!byBucket[key]) {
      byBucket[key] = {
        market: p.market,
        confidence_bucket: bucket,
        n_predictions: 0,
        n_hits: 0,
      };
    }
    byBucket[key].n_predictions += 1;
    if (p.hit) byBucket[key].n_hits += 1;
  }

  const marketSummary = Object.values(byMarket)
    .map((m) => ({ ...m, hit_rate: m.n > 0 ? m.hits / m.n : null }))
    .sort((a, b) => b.n - a.n);

  const buckets = Object.values(byBucket)
    .map((b) => ({
      ...b,
      hit_rate: b.n_predictions > 0 ? b.n_hits / b.n_predictions : null,
    }))
    .sort((a, b) => {
      if (a.market !== b.market) return a.market.localeCompare(b.market);
      return b.confidence_bucket - a.confidence_bucket;
    });

  return { marketSummary, buckets };
}

function getMarketCategory(market) {
  if (market === "home_run") return "HR";
  if (market === "hrr_2" || market === "hrr_3") return "HRR";
  if (market === "hit_2") return "Hit";
  if (market === "total_bases") return "TB";
  if (market === "strikeouts") return "K";
  return null;
}

export default function Review() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [progress, setProgress] = useState("");
  const [date, setDate] = useState(todayStr());
  const [savedParlays, setSavedParlays] = useState([]);
  const [parlaySyncState, setParlaySyncState] = useState({});
  const [expandedParlayIds, setExpandedParlayIds] = useState(() => new Set());
  const [selectedMarketCategories, setSelectedMarketCategories] = useState(new Set(["HR", "HRR", "Hit", "TB", "K"]));

  function persistSavedParlays(nextParlays) {
    try {
      localStorage.setItem(DAILY_PARLAYS_KEY, JSON.stringify(nextParlays));
    } catch {}
  }

  function loadSavedParlays() {
    try {
      const stored = localStorage.getItem(DAILY_PARLAYS_KEY);
      const parsed = stored ? JSON.parse(stored) : [];
      setSavedParlays(parsed.map((parlay) => recalculateParlayStatus(parlay)));
    } catch (error) {
      setSavedParlays([]);
      toast({
        title: "Saved parlays unavailable",
        description: `Could not read saved parlays from local storage: ${String(error?.message ?? error)}`,
        variant: "destructive",
      });
    }
  }

  function deleteSavedParlay(parlayId) {
    setSavedParlays((prev) => {
      const next = prev.filter((parlay) => parlay.id !== parlayId);
      persistSavedParlays(next);
      return next;
    });
    setExpandedParlayIds((prev) => {
      const next = new Set(prev);
      next.delete(parlayId);
      return next;
    });
  }

  function toggleSavedParlay(parlayId) {
    setExpandedParlayIds((prev) => {
      const next = new Set(prev);
      if (next.has(parlayId)) {
        next.delete(parlayId);
      } else {
        next.add(parlayId);
      }
      return next;
    });
  }

  useEffect(() => {
    loadSavedParlays();
  }, []);

  useEffect(() => {
    const syncState = savedParlays.reduce((acc, parlay) => {
      acc[parlay.id] = {
        status: parlay.status,
        completedLegs: parlay.completedLegs ?? 0,
        totalLegs: parlay.totalLegs ?? parlay.legs?.length ?? 0,
      };
      return acc;
    }, {});
    setParlaySyncState(syncState);
  }, [savedParlays]);

  const grade = useMutation({
    mutationFn: () => gradeAllUngraded(setProgress),
    onSuccess: (r) => {
      toast({ title: "Grading complete", description: r.message });
      setProgress("");
      qc.invalidateQueries({ queryKey: ["review"] });
    },
    onError: (e) => {
      toast({ title: "Error", description: String(e?.message ?? e), variant: "destructive" });
      setProgress("");
    },
  });

  const { data, isLoading } = useQuery({
    queryKey: ["review", date],
    queryFn: async () => {
      const [games, predictions] = await Promise.all([
        db.entities.Game.filter({ game_date: date }),
        db.entities.Prediction.filter({ game_date: date }),
      ]);

      const gameTimeByPk = new Map(games.map((g) => [g.game_pk, g.game_time_utc ?? null]));
      const predictionsWithGameTime = predictions.map((p) => ({
        ...p,
        game_time_utc: gameTimeByPk.get(p.game_pk) ?? null,
      }));

      const gradedPicks = predictionsWithGameTime.filter((p) => p.graded === true);
      const { marketSummary, buckets } = buildAccuracyFromPicks(gradedPicks);

      return { marketSummary, buckets, gradedPicks };
    },
  });

  useEffect(() => {
    if (isLoading) return;
    const gradedPicks = data?.gradedPicks ?? [];
    setSavedParlays((prev) => {
      const synced = syncAllParlays(prev, gradedPicks);
      if (savedParlaysEqual(prev, synced)) {
        return prev;
      }
      persistSavedParlays(synced);
      return synced;
    });
  }, [data, isLoading]);

  const savedParlaySummary = useMemo(() => (
    savedParlays.reduce((acc, parlay) => {
      const status = ["pending", "inProgress", "won", "lost"].includes(parlay.status) ? parlay.status : "pending";
      acc.total += 1;
      acc[status] = (acc[status] ?? 0) + 1;
      return acc;
    }, { total: 0, pending: 0, inProgress: 0, won: 0, lost: 0 })
  ), [savedParlays]);
  const displayedSavedParlays = useMemo(() => savedParlays.slice().reverse(), [savedParlays]);

  return (
    <AppShell>
      <div className="mb-6 flex items-end justify-between gap-3">
        <div>
          <div className="text-xs uppercase tracking-widest text-muted-foreground">Feedback loop</div>
          <h1 className="text-3xl font-black tracking-tight">Accuracy review</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Date-scoped hit rate and calibration. Includes per-parlay result tracking (hit/miss/pending) for the selected day.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-40" />
          <Button onClick={() => grade.mutate()} disabled={grade.isPending}>
            {grade.isPending ? "Grading…" : "Grade results"}
          </Button>
        </div>
      </div>

      {grade.isPending && progress && (
        <div className="mb-4 rounded border bg-muted/40 px-3 py-2 text-xs text-muted-foreground animate-pulse">
          {progress}
        </div>
      )}

      {isLoading && <div className="py-10 text-center text-muted-foreground">Loading…</div>}
      {!isLoading && (
        <div className="grid gap-6 md:grid-cols-2">
          <Card>
            <CardHeader><CardTitle>Overall hit rate by market</CardTitle></CardHeader>
            <CardContent>
              {(data?.marketSummary ?? []).length === 0 ? (
                <div className="py-8 text-center text-sm text-muted-foreground">No graded results yet. Run analysis, wait for games to finish, then grade.</div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Market</TableHead>
                      <TableHead className="text-right">N</TableHead>
                      <TableHead className="text-right">Hits</TableHead>
                      <TableHead className="text-right">Rate</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.marketSummary
                      .map((m) => (
                      <TableRow key={m.market}>
                        <TableCell>{getMarketLabel(m.market, "full")}</TableCell>
                        <TableCell className="text-right tabular-nums">{m.n}</TableCell>
                        <TableCell className="text-right tabular-nums">{m.hits}</TableCell>
                        <TableCell className="text-right tabular-nums font-bold">
                          {m.hit_rate != null ? `${(m.hit_rate * 100).toFixed(1)}%` : "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Calibration (confidence bucket → hit rate)</CardTitle></CardHeader>
            <CardContent>
              {(data?.buckets ?? []).length === 0 ? (
                <div className="py-8 text-center text-sm text-muted-foreground">No calibration data yet.</div>
              ) : (
                <div className="space-y-5">
                  {Object.entries(
                    data.buckets.reduce((acc, b) => {
                      (acc[b.market] ??= []).push(b);
                      return acc;
                    }, {})
                  ).map(([market, rows]) => (
                    <div key={market}>
                      <div className="mb-2 text-xs font-bold uppercase tracking-wide text-muted-foreground">
                        {getMarketLabel(market, "full")}
                      </div>
                      <div className="space-y-2">
                        {rows
                          .map((b) => (
                          <div key={`${b.market}-${b.confidence_bucket}`} className="flex items-center gap-3">
                            <div className="w-16 shrink-0 text-xs tabular-nums text-muted-foreground">
                              {b.confidence_bucket}-{b.confidence_bucket + 10}
                            </div>
                            <div className="flex-1">
                              <BucketBar rate={b.hit_rate} />
                            </div>
                            <div className="w-14 shrink-0 text-right text-xs font-bold tabular-nums">
                              {b.hit_rate != null ? `${(b.hit_rate * 100).toFixed(0)}%` : "—"}
                            </div>
                            <div className="w-10 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
                              n={b.n_predictions}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {!isLoading && (
        <Card className="mt-6">
          <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <div className="text-xs uppercase tracking-widest text-muted-foreground">Saved Parlays</div>
              <CardTitle>Saved Parlays for Review</CardTitle>
              <p className="mt-1 text-sm text-muted-foreground">
                Accuracy Review grading automatically updates matching saved parlay legs by player, market, and game.
              </p>
            </div>
            {savedParlaySummary.total > 0 && (
              <div className="flex flex-wrap gap-2 text-xs">
                <Badge variant="outline">Pending: {savedParlaySummary.pending}</Badge>
                <Badge variant="outline">In Progress: {savedParlaySummary.inProgress}</Badge>
                <Badge variant="outline">Won: {savedParlaySummary.won}</Badge>
                <Badge variant="outline">Lost: {savedParlaySummary.lost}</Badge>
              </div>
            )}
          </CardHeader>
          <CardContent>
            {savedParlays.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted-foreground">
                No saved parlays yet. Save parlays from the Parlays page and they will appear here for automatic review.
              </div>
            ) : (
              <div className="space-y-4">
                {displayedSavedParlays.map((parlay) => {
                  const syncStatus = parlaySyncState[parlay.id] ?? {
                    completedLegs: parlay.completedLegs ?? 0,
                    totalLegs: parlay.totalLegs ?? parlay.legs?.length ?? 0,
                    status: parlay.status,
                  };
                  const expanded = expandedParlayIds.has(parlay.id);
                  return (
                    <Card key={parlay.id}>
                      <CardHeader className="gap-3 pb-3">
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                          <div className="space-y-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <CardTitle className="text-base font-bold">{parlay.name}</CardTitle>
                              <Badge className={getSavedParlayStatusClass(syncStatus.status)}>
                                {getSavedParlayStatusLabel(syncStatus.status)}
                              </Badge>
                              {parlay.source === "custom" && <Badge variant="outline">Custom</Badge>}
                            </div>
                            <div className="text-xs text-muted-foreground">
                              Saved {formatSavedAt(parlay.savedAt)} · {syncStatus.totalLegs} legs
                            </div>
                            <div className="text-sm text-muted-foreground">
                              Progress: {syncStatus.completedLegs}/{syncStatus.totalLegs} legs completed
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <Button variant="outline" size="sm" onClick={() => toggleSavedParlay(parlay.id)}>
                              {expanded ? "Hide legs" : "Show legs"}
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-muted-foreground hover:text-destructive"
                              onClick={() => deleteSavedParlay(parlay.id)}
                            >
                              Delete
                            </Button>
                          </div>
                        </div>
                      </CardHeader>
                      {expanded && (
                        <CardContent className="pt-0">
                          <div className="overflow-x-auto">
                            <Table>
                              <TableHeader>
                                <TableRow>
                                  <TableHead>Player</TableHead>
                                  <TableHead>Market</TableHead>
                                  <TableHead className="text-right">Projection</TableHead>
                                  <TableHead className="text-right">Status</TableHead>
                                </TableRow>
                              </TableHeader>
                              <TableBody>
                                {parlay.legs.map((leg, legIndex) => (
                                  <TableRow key={`${parlay.id}-${getSavedParlayLegKey(leg, legIndex)}`}>
                                    <TableCell className="font-medium">
                                      {leg.player}
                                      {leg.teamName && (
                                        <span className="ml-2 text-xs font-normal text-muted-foreground">({leg.teamName})</span>
                                      )}
                                    </TableCell>
                                    <TableCell>{getMarketLabel(leg.market, "short")}</TableCell>
                                    <TableCell className="text-right tabular-nums">{formatLegProjection(leg)}</TableCell>
                                    <TableCell className="text-right">
                                      <Badge variant={leg.result === "pending" ? "outline" : leg.result === "hit" ? "default" : "destructive"}>
                                        {getLegResultLabel(leg.result)}
                                      </Badge>
                                    </TableCell>
                                  </TableRow>
                                ))}
                              </TableBody>
                            </Table>
                          </div>
                        </CardContent>
                      )}
                    </Card>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {!isLoading && (
        <Card className="mt-6">
          <CardHeader><CardTitle>Graded picks</CardTitle></CardHeader>
          <CardContent>
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <div className="text-xs uppercase tracking-widest text-muted-foreground">Filter by market:</div>
              {["HR", "HRR", "Hit", "TB", "K"].map((cat) => (
                <button
                  key={cat}
                  onClick={() => {
                    setSelectedMarketCategories((prev) => {
                      const next = new Set(prev);
                      if (next.has(cat)) next.delete(cat);
                      else next.add(cat);
                      return next;
                    });
                  }}
                  className={`rounded px-3 py-1 text-xs font-medium transition-colors ${
                    selectedMarketCategories.has(cat)
                      ? "bg-primary text-primary-foreground"
                      : "border border-input bg-background hover:bg-accent"
                  }`}
                >
                  {cat}
                </button>
              ))}
            </div>
            <PicksReviewTable picks={data?.gradedPicks?.filter((p) => selectedMarketCategories.has(getMarketCategory(p.market)))} />
          </CardContent>
        </Card>
      )}
    </AppShell>
  );
}