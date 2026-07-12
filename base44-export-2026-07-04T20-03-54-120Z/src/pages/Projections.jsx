import React, { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import AppShell from "@/components/mlb/AppShell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { ChevronDown, ChevronUp, ChevronsUpDown } from "lucide-react";
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

// Returns the "expected" value for a row given the market key
function expectedValue(p, market) {
  if (market.includes("HR") || market.includes("home_run")) return Number(p.expected_home_runs ?? 0);
  if (market.includes("HRR") || market.includes("hrr")) return Number(p.expected_hrr ?? 0);
  if (market.includes("Total") || market.includes("total_bases")) return Number(p.expected_total_bases ?? 0);
  return Number(p.expected_hits ?? 0);
}

// Sort icon next to a column header
function SortIcon({ col, sortCol, sortDir }) {
  if (sortCol !== col) return <ChevronsUpDown className="inline ml-1 h-3 w-3 opacity-40" />;
  return sortDir === "desc"
    ? <ChevronDown className="inline ml-1 h-3 w-3 text-primary" />
    : <ChevronUp className="inline ml-1 h-3 w-3 text-primary" />;
}

// Sortable column header button
function SortHead({ col, label, sortCol, sortDir, onSort, className = "" }) {
  return (
    <TableHead
      className={`cursor-pointer select-none whitespace-nowrap ${className}`}
      onClick={() => onSort(col)}
    >
      {label}
      <SortIcon col={col} sortCol={sortCol} sortDir={sortDir} />
    </TableHead>
  );
}

function MarketRankingTable({ market, rankings }) {
  const [collapsed, setCollapsed] = useState(false);
  const [sortCol, setSortCol] = useState("projection_score");
  const [sortDir, setSortDir] = useState("desc");

  function handleSort(col) {
    if (sortCol === col) {
      setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSortCol(col);
      setSortDir("desc");
    }
  }

  const sorted = useMemo(() => {
    const rows = [...rankings];
    rows.sort((a, b) => {
      let av, bv;
      switch (sortCol) {
        case "projection_score": av = Number(a.projection_score ?? 0); bv = Number(b.projection_score ?? 0); break;
        case "expected":         av = expectedValue(a, market);         bv = expectedValue(b, market);         break;
        case "confidence_score": av = Number(a.confidence_score ?? 0); bv = Number(b.confidence_score ?? 0); break;
        case "market_edge":      av = Number(a.market_edge ?? 0);      bv = Number(b.market_edge ?? 0);      break;
        case "projection":       av = Number(a.projection ?? 0);       bv = Number(b.projection ?? 0);       break;
        default:                 av = 0; bv = 0;
      }
      return sortDir === "desc" ? bv - av : av - bv;
    });
    return rows;
  }, [rankings, sortCol, sortDir, market]);

  return (
    <Card className="mb-6">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg">{marketDisplay(market)}</CardTitle>
          <button
            type="button"
            onClick={() => setCollapsed((v) => !v)}
            className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted transition-colors"
            aria-expanded={!collapsed}
          >
            {collapsed ? (
              <><ChevronDown className="h-3.5 w-3.5" /> Show {rankings.length} players</>
            ) : (
              <><ChevronUp className="h-3.5 w-3.5" /> Hide</>
            )}
          </button>
        </div>
      </CardHeader>

      {!collapsed && (
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12">Rank</TableHead>
                  <TableHead>Player</TableHead>
                  <SortHead col="projection_score" label="Projection Score" sortCol={sortCol} sortDir={sortDir} onSort={handleSort} className="text-right" />
                  <SortHead col="expected"         label="Expected"         sortCol={sortCol} sortDir={sortDir} onSort={handleSort} className="text-right" />
                  <SortHead col="confidence_score" label="Confidence"       sortCol={sortCol} sortDir={sortDir} onSort={handleSort} className="text-right" />
                  <SortHead col="market_edge"      label="Edge"             sortCol={sortCol} sortDir={sortDir} onSort={handleSort} className="text-right" />
                  <SortHead col="projection"       label="Model %"          sortCol={sortCol} sortDir={sortDir} onSort={handleSort} className="text-right" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {sorted.map((p, idx) => (
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
                      {expectedValue(p, market).toFixed(2)}
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
      )}
    </Card>
  );
}

export default function Projections() {
  const [date, setDate] = useState(todayStr());

  const { data, isLoading } = useQuery({
    queryKey: ["projections", date],
    queryFn: async () => {
      const predictions = await db.entities.Prediction.filter({ game_date: date });
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
  }, [predictions, rankings]);

  return (
    <AppShell>
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="mb-6 flex items-end justify-between">
        <div>
          <div className="text-xs uppercase tracking-widest text-muted-foreground">Analytics</div>
          <h1 className="text-3xl font-black tracking-tight">Player Projection Scores</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Ranked players by projection score across all markets. Click any column header to sort. Click the market header to fold/unfold.
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

          {/* ── Market Rankings ──────────────────────────────────────── */}
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
