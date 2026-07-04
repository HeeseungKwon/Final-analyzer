const db = globalThis.__B44_DB__ || { auth:{ isAuthenticated: async()=>false, me: async()=>null }, entities:new Proxy({}, { get:()=>({ filter:async()=>[], get:async()=>null, create:async()=>({}), update:async()=>({}), delete:async()=>({}) }) }), integrations:{ Core:{ UploadFile:async()=>({ file_url:'' }) } } };

import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

import AppShell from "@/components/mlb/AppShell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/components/ui/use-toast";
import { gradeAllUngraded } from "@/lib/grading";
import BucketBar from "@/components/mlb/BucketBar";
import PicksReviewTable from "@/components/mlb/PicksReviewTable";

const MARKET_LABEL = {
  hit_1: "1+ Hit",
  hit_2: "2+ Hits",
  hrr: "HRR",
  total_bases: "Total Bases",
  home_run: "Home Run",
  strikeouts: "Strikeouts",
};

export default function Review() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [progress, setProgress] = useState("");

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
    queryKey: ["review"],
    queryFn: async () => {
      const accuracy = await db.entities.MarketAccuracy.list();
      // Build market summary (aggregate by market)
      const byMarket = {};
      for (const a of accuracy) {
        if (!byMarket[a.market]) byMarket[a.market] = { market: a.market, n: 0, hits: 0 };
        byMarket[a.market].n += a.n_predictions || 0;
        byMarket[a.market].hits += a.n_hits || 0;
      }
      const marketSummary = Object.values(byMarket).map((m) => ({
        ...m,
        hit_rate: m.n > 0 ? m.hits / m.n : null,
      }));
      // Buckets: each MarketAccuracy record is a bucket, sorted descending
      // by bucket within each market.
      const buckets = accuracy
        .map((a) => ({
          market: a.market,
          confidence_bucket: a.confidence_bucket ?? 0,
          n_predictions: a.n_predictions ?? 0,
          hit_rate: a.hit_rate,
        }))
        .sort((a, b) => {
          if (a.market !== b.market) return a.market.localeCompare(b.market);
          return b.confidence_bucket - a.confidence_bucket;
        });

      const gradedPicks = (await db.entities.Prediction.filter({ graded: true }, "-game_date")) ?? [];

      return { marketSummary, buckets, gradedPicks };
    },
  });

  return (
    <AppShell>
      <div className="mb-6 flex items-end justify-between">
        <div>
          <div className="text-xs uppercase tracking-widest text-muted-foreground">Feedback loop</div>
          <h1 className="text-3xl font-black tracking-tight">Accuracy review</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Hit rate by market and confidence bucket. Well-calibrated markets show hit rate rising with confidence.
          </p>
        </div>
        <Button onClick={() => grade.mutate()} disabled={grade.isPending}>
          {grade.isPending ? "Grading…" : "Grade results"}
        </Button>
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