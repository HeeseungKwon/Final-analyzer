import React, { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import AppShell from "@/components/mlb/AppShell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { getAllMarketRankings, getProjectionSummary } from "@/lib/projection-scorer";

const db = globalThis.__B44_DB__ || {
  auth: { isAuthenticated: async () => false, me: async () => null },
  entities: new Proxy({}, {
    get: () => ({
      filter: async () => [],
      get: async () => null,
      create: async () => ({}),
      update: async () => ({}),
      delete: async () => ({})
    })
  }),
  integrations: { Core: { UploadFile: async () => ({ file_url: '' }) } }
};

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function gradeBadge(projectionScore) {
  if (projectionScore >= 75) return <Badge className="bg-green-600 hover:bg-green-600">A+</Badge>;
  if (projectionScore >= 70) return <Badge className="bg-green-500 hover:bg-green-500">A</Badge>;
  if (projectionScore >= 65) return <Badge className="bg-blue-500 hover:bg-blue-500">B+</Badge>;
  if (projectionScore >= 60) return <Badge className="bg-blue-400 hover:bg-blue-400">B</Badge>;
  if (projectionScore >= 55) return <Badge className="bg-yellow-500 hover:bg-yellow-500">C+</Badge>;
  if (projectionScore >= 50) return <Badge className="bg-yellow-400 hover:bg-yellow-400">C</Badge>;
  return <Badge className="bg-red-400 hover:bg-red-400">D</Badge>;
}

function marketDisplay(market) {
  const labels = {
    "2+ Hits": "2+ Hits",
    "2+ Total Bases": "TB O1.5",
    "3+ Total Bases": "TB O2.5",
    "1+ HR": "Home Run",
    "home_run": "Home Run",
    "2+ HRR": "HRR O1.5",
    "3+ HRR": "HRR O2.5",
    "hrr_2": "HRR O1.5",
    "hrr_3": "HRR O2.5",
  };
  return labels[market] || market;
}

function MarketRankingTable({ market, rankings }) {
  return (
    <Card className="mb-6">
      <CardHeader className="pb-3">
        <CardTitle className="text-lg">{marketDisplay(market)}</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12">Rank</TableHead>
                <TableHead>Player</TableHead>
                <TableHead className="text-right">Projection Score</TableHead>
                <TableHead className="text-right">Expected</TableHead>
                <TableHead className="text-right">Confidence</TableHead>
                <TableHead className="text-right">Edge</TableHead>
                <TableHead className="text-right">Model %</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rankings.map((p, idx) => (
                <TableRow key={p.id || idx}>
                  <TableCell className="font-bold">{p.rank}</TableCell>
                  <TableCell className="font-medium">
                    {p.player_name}
                    <div className="text-xs text-muted-foreground mt-1">{p.team_name}</div>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-2">
                      <span className="font-bold">{Number(p.projection_score).toFixed(1)}</span>
                      {gradeBadge(p.projection_score)}
                    </div>
                  </TableCell>
                  <TableCell className="text-right text-sm">
                    {market.includes("HR") || market.includes("home_run")
                      ? Number(p.expected_home_runs ?? 0).toFixed(2)
                      : market.includes("3+ Total")
                      ? Number(p.expected_total_bases ?? 0).toFixed(2)
                      : market.includes("2+ Total")
                      ? Number(p.expected_total_bases ?? 0).toFixed(2)
                      : market.includes("HRR") || market.includes("hrr")
                      ? Number(p.expected_hrr ?? 0).toFixed(2)
                      : Number(p.expected_hits ?? 0).toFixed(2)}
                  </TableCell>
                  <TableCell className="text-right text-sm">
                    {Number(p.confidence_score ?? 0).toFixed(0)}
                  </TableCell>
                  <TableCell className="text-right text-sm">
                    <span className={p.market_edge > 0 ? "text-green-600 font-semibold" : p.market_edge < 0 ? "text-red-600" : ""}>
                      {((p.market_edge ?? 0) * 100).toFixed(1)}%
                    </span>
                  </TableCell>
                  <TableCell className="text-right text-sm">
                    {(Number(p.projection ?? 0.5) * 100).toFixed(1)}%
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

export default function Projections() {
  const [date, setDate] = useState(todayStr());

  const { data, isLoading } = useQuery({
    queryKey: ["projections", date],
    queryFn: async () => {
      const predictions = await db.entities.Prediction.filter({ game_date: date });
      // Filter to only predictions with projection scores
      const withScores = predictions.filter(p => p.projection_score != null && p.expected_hits != null);
      return { predictions: withScores };
    },
  });

  const predictions = data?.predictions ?? [];

  const rankings = useMemo(() => {
    return getAllMarketRankings(predictions);
  }, [predictions]);

  const summaries = useMemo(() => {
    const markets = Object.keys(rankings);
    return markets.map(market => getProjectionSummary(predictions, market)).filter(s => s != null);
  }, [predictions]);

  return (
    <AppShell>
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="mb-6 flex items-end justify-between">
        <div>
          <div className="text-xs uppercase tracking-widest text-muted-foreground">Analytics</div>
          <h1 className="text-3xl font-black tracking-tight">Player Projection Scores</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Ranked players by projection score across all markets. Combines model probability, expected projections, market edge, and confidence.
          </p>
        </div>
        <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-40" />
      </div>

      {isLoading && <div className="py-10 text-center text-muted-foreground">Loading…</div>}

      {!isLoading && predictions.length === 0 && (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No projections found for this date. Run analysis first.
          </CardContent>
        </Card>
      )}

      {!isLoading && predictions.length > 0 && (
        <>
          {/* ── Summary Dashboard ────────────────────────────────────── */}
          {summaries.length > 0 && (
            <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {summaries.map((summary) => (
                <Card key={summary.market}>
                  <CardContent className="pt-6">
                    <div className="space-y-2">
                      <h3 className="text-sm font-semibold">{marketDisplay(summary.market)}</h3>
                      <div>
                        <div className="text-xs text-muted-foreground">Top Score</div>
                        <div className="text-2xl font-bold">{summary.topScore.toFixed(1)}</div>
                      </div>
                      <div>
                        <div className="text-xs text-muted-foreground">Average Score</div>
                        <div className="text-lg font-semibold">{summary.avgScore.toFixed(1)}</div>
                      </div>
                      <div>
                        <div className="text-xs text-muted-foreground">Avg Edge</div>
                        <div className={`text-sm font-semibold ${summary.avgEdge > 0 ? "text-green-600" : "text-red-600"}`}>
                          {(summary.avgEdge * 100).toFixed(1)}%
                        </div>
                      </div>
                      <div>
                        <div className="text-xs text-muted-foreground">Positive Edge</div>
                        <div className="text-sm font-semibold">{summary.positiveedgeCount} / {summary.count}</div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}

          {/* ── Market Rankings ───────────────────────────────────────– */}
          <div className="space-y-6">
            {Object.entries(rankings).map(([market, playerRankings]) => (
              <MarketRankingTable key={market} market={market} rankings={playerRankings} />
            ))}
          </div>
        </>
      )}
    </AppShell>
  );
}
