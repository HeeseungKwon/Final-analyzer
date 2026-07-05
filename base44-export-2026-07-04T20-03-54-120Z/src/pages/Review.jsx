const db = globalThis.__B44_DB__ || { auth:{ isAuthenticated: async()=>false, me: async()=>null }, entities:new Proxy({}, { get:()=>({ filter:async()=>[], get:async()=>null, create:async()=>({}), update:async()=>({}), delete:async()=>({}) }) }), integrations:{ Core:{ UploadFile:async()=>({ file_url:'' }) } } };

import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

import AppShell from "@/components/mlb/AppShell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/components/ui/use-toast";
import { gradeAllUngraded } from "@/lib/grading";
import { buildParlays, buildHRParlays } from "@/lib/parlays";
import { runOneTimeABComparison } from "@/lib/ab-comparison";
import { getMarketLabel } from "@/lib/constants/markets";
import BucketBar from "@/components/mlb/BucketBar";
import PicksReviewTable from "@/components/mlb/PicksReviewTable";

const MARKET_LABEL = {
  hit_2: "2+ Hits",
  hrr_2: "HRR 2.5",
  hrr_3: "HRR 3.5",
  total_bases: "Total Bases",
  home_run: "Home Run",
  strikeouts: "Strikeouts",
};

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
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

function evaluateParlayResults(parlays, predictionById) {
  const rows = parlays.map((parlay) => {
    let gradedLegs = 0;
    let hitLegs = 0;
    let missLegs = 0;

    const legs = parlay.legs.map((leg) => {
      const pred = predictionById.get(leg.predictionId);
      const hit = pred?.graded ? pred.hit : null;
      if (hit === true) {
        gradedLegs += 1;
        hitLegs += 1;
      } else if (hit === false) {
        gradedLegs += 1;
        missLegs += 1;
      }
      return {
        ...leg,
        hit,
        marketLabel: getMarketLabel(leg.market, "short"),
      };
    });

    const settled = gradedLegs === parlay.legs.length;
    const won = settled ? missLegs === 0 : null;

    return {
      ...parlay,
      legs,
      gradedLegs,
      hitLegs,
      missLegs,
      pendingLegs: parlay.legs.length - gradedLegs,
      settled,
      won,
      hitRate: gradedLegs > 0 ? hitLegs / gradedLegs : null,
    };
  });

  const settledParlays = rows.filter((r) => r.settled);
  const wonParlays = settledParlays.filter((r) => r.won).length;

  return {
    rows,
    settled: settledParlays.length,
    won: wonParlays,
    winRate: settledParlays.length > 0 ? wonParlays / settledParlays.length : null,
  };
}

function LegStatusBadge({ hit }) {
  if (hit === true) {
    return <Badge className="bg-emerald-100 text-emerald-800 hover:bg-emerald-100">Hit</Badge>;
  }
  if (hit === false) {
    return <Badge className="bg-rose-100 text-rose-800 hover:bg-rose-100">Miss</Badge>;
  }
  return <Badge variant="outline">Pending</Badge>;
}

export default function Review() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [progress, setProgress] = useState("");
  const [date, setDate] = useState(todayStr());
  const [abProgress, setAbProgress] = useState("");
  const [abResult, setAbResult] = useState(null);

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

  const abCompare = useMutation({
    mutationFn: () => runOneTimeABComparison(date, setAbProgress),
    onSuccess: (r) => {
      setAbResult(r);
      setAbProgress("");
      toast({ title: "A/B comparison complete", description: `Compared legacy vs modern picks for ${r.date}` });
    },
    onError: (e) => {
      setAbProgress("");
      toast({ title: "A/B comparison error", description: String(e?.message ?? e), variant: "destructive" });
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

      const predictionById = new Map(predictionsWithGameTime.map((p) => [p.id, p]));
      const parlaySummary = evaluateParlayResults(buildParlays(predictionsWithGameTime), predictionById);
      const hrParlaySummary = evaluateParlayResults(buildHRParlays(predictionsWithGameTime), predictionById);

      return { marketSummary, buckets, gradedPicks, parlaySummary, hrParlaySummary };
    },
  });

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
          <Button variant="outline" onClick={() => abCompare.mutate()} disabled={abCompare.isPending}>
            {abCompare.isPending ? "Running A/B…" : "Run one-time A/B"}
          </Button>
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

      {abCompare.isPending && abProgress && (
        <div className="mb-4 rounded border bg-muted/40 px-3 py-2 text-xs text-muted-foreground animate-pulse">
          {abProgress}
        </div>
      )}

      {!isLoading && abResult && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>One-time A/B comparison ({abResult.date})</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="mb-3 text-xs text-muted-foreground">{abResult.note}</div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Model</TableHead>
                  <TableHead className="text-right">Raw recommended</TableHead>
                  <TableHead className="text-right">Portfolio recommended</TableHead>
                  <TableHead className="text-right">Graded</TableHead>
                  <TableHead className="text-right">Hits</TableHead>
                  <TableHead className="text-right">Hit rate</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow>
                  <TableCell className="font-medium">Legacy (old)</TableCell>
                  <TableCell className="text-right tabular-nums">{abResult.legacyRaw?.recommended ?? abResult.legacy.recommended}</TableCell>
                  <TableCell className="text-right tabular-nums">{abResult.legacy.recommended}</TableCell>
                  <TableCell className="text-right tabular-nums">{abResult.legacy.graded}</TableCell>
                  <TableCell className="text-right tabular-nums">{abResult.legacy.hits}</TableCell>
                  <TableCell className="text-right tabular-nums font-semibold">{abResult.legacy.hitRate != null ? `${(abResult.legacy.hitRate * 100).toFixed(1)}%` : "—"}</TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="font-medium">Modern (new)</TableCell>
                  <TableCell className="text-right tabular-nums">{abResult.modernRaw?.recommended ?? abResult.modern.recommended}</TableCell>
                  <TableCell className="text-right tabular-nums">{abResult.modern.recommended}</TableCell>
                  <TableCell className="text-right tabular-nums">{abResult.modern.graded}</TableCell>
                  <TableCell className="text-right tabular-nums">{abResult.modern.hits}</TableCell>
                  <TableCell className="text-right tabular-nums font-semibold">{abResult.modern.hitRate != null ? `${(abResult.modern.hitRate * 100).toFixed(1)}%` : "—"}</TableCell>
                </TableRow>
              </TableBody>
            </Table>

            <div className="mt-4 text-xs text-muted-foreground">Overlapping recommended picks: {abResult.overlapCount}</div>

            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">Legacy-only picks</CardTitle>
                </CardHeader>
                <CardContent>
                  {abResult.legacyOnly.length === 0 ? (
                    <div className="text-xs text-muted-foreground">None</div>
                  ) : (
                    <div className="space-y-1">
                      {abResult.legacyOnly.slice(0, 20).map((p) => (
                        <div key={`legacy-${p.game_pk}-${p.player_id}-${p.market}`} className="flex items-center justify-between gap-2 text-xs">
                          <span className="truncate text-muted-foreground">{p.player_name} · {getMarketLabel(p.market, "short")}</span>
                          <Badge variant={p.hit == null ? "outline" : p.hit ? "default" : "destructive"}>{p.hit == null ? "pending" : p.hit ? "hit" : "miss"}</Badge>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">Modern-only picks</CardTitle>
                </CardHeader>
                <CardContent>
                  {abResult.modernOnly.length === 0 ? (
                    <div className="text-xs text-muted-foreground">None</div>
                  ) : (
                    <div className="space-y-1">
                      {abResult.modernOnly.slice(0, 20).map((p) => (
                        <div key={`modern-${p.game_pk}-${p.player_id}-${p.market}`} className="flex items-center justify-between gap-2 text-xs">
                          <span className="truncate text-muted-foreground">{p.player_name} · {getMarketLabel(p.market, "short")}</span>
                          <Badge variant={p.hit == null ? "outline" : p.hit ? "default" : "destructive"}>{p.hit == null ? "pending" : p.hit ? "hit" : "miss"}</Badge>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          </CardContent>
        </Card>
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
                    {data.marketSummary.map((m) => (
                      <TableRow key={m.market}>
                        <TableCell>{MARKET_LABEL[m.market] ?? m.market}</TableCell>
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
                        {MARKET_LABEL[market] ?? market}
                      </div>
                      <div className="space-y-2">
                        {rows.map((b) => (
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
        <div className="mt-6 grid gap-6 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Daily parlays results</CardTitle>
            </CardHeader>
            <CardContent>
              {(data?.parlaySummary?.rows ?? []).length === 0 ? (
                <div className="py-8 text-center text-sm text-muted-foreground">No parlays generated for this date.</div>
              ) : (
                <>
                  <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
                    <Badge variant="outline">Settled: {data.parlaySummary.settled}</Badge>
                    <Badge variant="outline">Won: {data.parlaySummary.won}</Badge>
                    <Badge variant="outline">
                      Win rate: {data.parlaySummary.winRate != null ? `${(data.parlaySummary.winRate * 100).toFixed(1)}%` : "—"}
                    </Badge>
                  </div>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Parlay</TableHead>
                        <TableHead>Picks</TableHead>
                        <TableHead className="text-right">Hit</TableHead>
                        <TableHead className="text-right">Miss</TableHead>
                        <TableHead className="text-right">Pending</TableHead>
                        <TableHead className="text-right">Leg hit rate</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.parlaySummary.rows.map((r) => (
                        <TableRow key={r.name}>
                          <TableCell className="font-medium">
                            {r.name}
                            <div className="text-xs text-muted-foreground">
                              {r.settled ? (r.won ? "Won" : "Lost") : "Pending"}
                            </div>
                          </TableCell>
                          <TableCell>
                            <div className="space-y-1">
                              {r.legs.map((l) => (
                                <div key={l.predictionId} className="flex items-center justify-between gap-2 text-xs">
                                  <span className="truncate text-muted-foreground">
                                    {l.player} · {l.marketLabel}
                                  </span>
                                  <LegStatusBadge hit={l.hit} />
                                </div>
                              ))}
                            </div>
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{r.hitLegs}</TableCell>
                          <TableCell className="text-right tabular-nums">{r.missLegs}</TableCell>
                          <TableCell className="text-right tabular-nums">{r.pendingLegs}</TableCell>
                          <TableCell className="text-right tabular-nums font-semibold">
                            {r.hitRate != null ? `${(r.hitRate * 100).toFixed(1)}%` : "—"}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Daily HR parlays results</CardTitle>
            </CardHeader>
            <CardContent>
              {(data?.hrParlaySummary?.rows ?? []).length === 0 ? (
                <div className="py-8 text-center text-sm text-muted-foreground">No HR parlays generated for this date.</div>
              ) : (
                <>
                  <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
                    <Badge variant="outline">Settled: {data.hrParlaySummary.settled}</Badge>
                    <Badge variant="outline">Won: {data.hrParlaySummary.won}</Badge>
                    <Badge variant="outline">
                      Win rate: {data.hrParlaySummary.winRate != null ? `${(data.hrParlaySummary.winRate * 100).toFixed(1)}%` : "—"}
                    </Badge>
                  </div>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Parlay</TableHead>
                        <TableHead>Picks</TableHead>
                        <TableHead className="text-right">Hit</TableHead>
                        <TableHead className="text-right">Miss</TableHead>
                        <TableHead className="text-right">Pending</TableHead>
                        <TableHead className="text-right">Leg hit rate</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.hrParlaySummary.rows.map((r) => (
                        <TableRow key={r.name}>
                          <TableCell className="font-medium">
                            {r.name}
                            <div className="text-xs text-muted-foreground">
                              {r.settled ? (r.won ? "Won" : "Lost") : "Pending"}
                            </div>
                          </TableCell>
                          <TableCell>
                            <div className="space-y-1">
                              {r.legs.map((l) => (
                                <div key={l.predictionId} className="flex items-center justify-between gap-2 text-xs">
                                  <span className="truncate text-muted-foreground">
                                    {l.player} · {l.marketLabel}
                                  </span>
                                  <LegStatusBadge hit={l.hit} />
                                </div>
                              ))}
                            </div>
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{r.hitLegs}</TableCell>
                          <TableCell className="text-right tabular-nums">{r.missLegs}</TableCell>
                          <TableCell className="text-right tabular-nums">{r.pendingLegs}</TableCell>
                          <TableCell className="text-right tabular-nums font-semibold">
                            {r.hitRate != null ? `${(r.hitRate * 100).toFixed(1)}%` : "—"}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {!isLoading && (
        <Card className="mt-6">
          <CardHeader><CardTitle>Graded picks</CardTitle></CardHeader>
          <CardContent>
            <PicksReviewTable picks={data?.gradedPicks} />
          </CardContent>
        </Card>
      )}
    </AppShell>
  );
}