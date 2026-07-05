const db = globalThis.__B44_DB__ || { auth:{ isAuthenticated: async()=>false, me: async()=>null }, entities:new Proxy({}, { get:()=>({ filter:async()=>[], get:async()=>null, create:async()=>({}), update:async()=>({}), delete:async()=>({}) }) }), integrations:{ Core:{ UploadFile:async()=>({ file_url:'' }) } } };

import React, { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import AppShell from "@/components/mlb/AppShell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { buildParlays, buildHRParlays } from "@/lib/parlays";

const MARKET_SHORT = {
  hit_2: "2+ Hits",
  hrr_2: "HRR 2.5",
  hrr_3: "HRR 3.5",
  total_bases: "TB 2.5",
  home_run: "HR",
  strikeouts: "K 6.5",
};

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function Parlays() {
  const [date, setDate] = useState(todayStr());
  const [selectedGamePks, setSelectedGamePks] = useState(new Set());

  const { data, isLoading } = useQuery({
    queryKey: ["parlays", date],
    queryFn: async () => {
      const [games, predictions] = await Promise.all([
        db.entities.Game.filter({ game_date: date }),
        db.entities.Prediction.filter({ game_date: date }),
      ]);

      const gameTimeByPk = new Map(games.map((g) => [g.game_pk, g.game_time_utc ?? null]));

      const eligiblePredictions = predictions.map((p) => ({
        ...p,
        game_time_utc: gameTimeByPk.get(p.game_pk) ?? null,
      }));

      return {
        games,
        eligiblePredictions,
        note: eligiblePredictions.length === 0 ? "No parlays available. Run today's analysis on the Today page first." : "Parlays are algorithmic suggestions from your own model — not betting advice. All legs must hit for a parlay to win.",
      };
    },
  });

  // Reset selected games whenever the date changes
  React.useEffect(() => {
    setSelectedGamePks(new Set());
  }, [date]);

  const games = data?.games ?? [];
  const eligiblePredictions = data?.eligiblePredictions ?? [];

  // All-day parlays (existing behaviour)
  const parlays = useMemo(() => buildParlays(eligiblePredictions), [eligiblePredictions]);
  const hrParlays = useMemo(() => buildHRParlays(eligiblePredictions), [eligiblePredictions]);

  // Custom: predictions filtered to selected games
  const customPredictions = useMemo(
    () => selectedGamePks.size > 0
      ? eligiblePredictions.filter((p) => selectedGamePks.has(p.game_pk))
      : [],
    [eligiblePredictions, selectedGamePks]
  );

  const customParlays = useMemo(() => buildParlays(customPredictions), [customPredictions]);
  const customHrParlays = useMemo(() => buildHRParlays(customPredictions), [customPredictions]);

  // Top recommended picks from selected games, sorted by rec_score
  const customPicks = useMemo(
    () =>
      customPredictions
        .filter((p) => p.recommended)
        .sort((a, b) => (b.rec_score ?? 0) - (a.rec_score ?? 0))
        .slice(0, 20),
    [customPredictions]
  );

  function toggleGame(pk) {
    setSelectedGamePks((prev) => {
      const next = new Set(prev);
      next.has(pk) ? next.delete(pk) : next.add(pk);
      return next;
    });
  }

  function selectAll() {
    setSelectedGamePks(new Set(games.map((g) => g.game_pk)));
  }

  function clearAll() {
    setSelectedGamePks(new Set());
  }

  return (
    <AppShell>
      <div className="mb-6 flex items-end justify-between">
        <div>
          <div className="text-xs uppercase tracking-widest text-muted-foreground">Portfolio</div>
          <h1 className="text-3xl font-black tracking-tight">Daily parlays</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Time-windowed parlays built from today's projections. Pick specific games below to get custom picks and parlays for just those matchups.
          </p>
        </div>
        <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-40" />
      </div>

      {isLoading && <div className="py-10 text-center text-muted-foreground">Loading…</div>}
      {!isLoading && parlays.length === 0 && selectedGamePks.size === 0 && (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            {data?.note ?? "No parlays available. Run today's analysis on the Today page first."}
          </CardContent>
        </Card>
      )}

      {/* ── Game Selector ─────────────────────────────────────────── */}
      {!isLoading && games.length > 0 && (
        <div className="mb-8">
          <div className="mb-3 flex items-center gap-3">
            <div>
              <div className="text-xs uppercase tracking-widest text-muted-foreground">Custom Builder</div>
              <h2 className="text-xl font-black tracking-tight">Pick your games</h2>
            </div>
            <div className="ml-auto flex gap-2">
              <Button variant="outline" size="sm" onClick={selectAll}>Select all</Button>
              <Button variant="outline" size="sm" onClick={clearAll} disabled={selectedGamePks.size === 0}>Clear</Button>
            </div>
          </div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {games.map((g) => {
              const selected = selectedGamePks.has(g.game_pk);
              const gameTime = g.game_time_utc
                ? new Date(g.game_time_utc).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
                : "";
              return (
                <label
                  key={g.game_pk}
                  className={`flex cursor-pointer items-center gap-3 rounded-md border p-3 transition-colors hover:bg-muted/40 ${selected ? "border-primary bg-primary/5" : ""}`}
                >
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-primary"
                    checked={selected}
                    onChange={() => toggleGame(g.game_pk)}
                  />
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{g.away_team_name} @ {g.home_team_name}</div>
                    {gameTime && <div className="text-xs text-muted-foreground">{gameTime}</div>}
                  </div>
                </label>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Custom Picks + Parlays for Selected Games ───────────────── */}
      {selectedGamePks.size > 0 && (
        <div className="mb-10">
          <div className="mb-4">
            <div className="text-xs uppercase tracking-widest text-muted-foreground">Selected games</div>
            <h2 className="text-2xl font-black tracking-tight">Picks &amp; parlays</h2>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
              Top recommended picks and parlays built from the {selectedGamePks.size} selected game{selectedGamePks.size > 1 ? "s" : ""} only.
            </p>
          </div>

          {/* Top individual picks */}
          {customPicks.length > 0 && (
            <Card className="mb-4">
              <CardHeader className="pb-3">
                <CardTitle className="text-base font-bold">Top picks from selected games</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Player</TableHead>
                        <TableHead>Team</TableHead>
                        <TableHead>Market</TableHead>
                        <TableHead className="text-right">Proj</TableHead>
                        <TableHead className="text-right">Conf</TableHead>
                        <TableHead className="text-right">Rec Score</TableHead>
                        <TableHead>Verdict</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {customPicks.map((p) => (
                        <TableRow key={p.id}>
                          <TableCell className="font-medium">{p.player_name}</TableCell>
                          <TableCell className="text-xs text-muted-foreground">{p.team_name}</TableCell>
                          <TableCell>{MARKET_SHORT[p.market] ?? p.market}</TableCell>
                          <TableCell className="text-right tabular-nums">
                            {p.market === "home_run" || p.market === "hit_2"
                              ? `${(p.projection * 100).toFixed(1)}%`
                              : Number(p.projection).toFixed(2)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{Number(p.confidence).toFixed(0)}</TableCell>
                          <TableCell className="text-right tabular-nums">{Number(p.rec_score).toFixed(1)}</TableCell>
                          <TableCell>
                            {p.verdict === "strong" && <Badge className="bg-emerald-600 hover:bg-emerald-600 text-xs">STRONG</Badge>}
                            {p.verdict === "middling" && <Badge className="bg-blue-600 hover:bg-blue-600 text-xs">MIDDLING</Badge>}
                            {p.verdict === "fade" && <Badge variant="destructive" className="text-xs">FADE</Badge>}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          )}
          {customPicks.length === 0 && (
            <Card className="mb-4">
              <CardContent className="py-6 text-center text-sm text-muted-foreground">
                No recommended picks found for the selected game{selectedGamePks.size > 1 ? "s" : ""}. Try running analysis on the Today page.
              </CardContent>
            </Card>
          )}

          {/* Custom parlays */}
          <div className="grid gap-4">
            {[...customParlays, ...customHrParlays].map((p) => {
              const edge = p.edge;
              const good = edge > 0;
              return (
                <Card key={p.name}>
                  <CardHeader className="flex-row items-start justify-between space-y-0 pb-3">
                    <div>
                      <CardTitle className="text-base font-bold">{p.name}</CardTitle>
                      <div className="mt-1 max-w-2xl text-xs text-muted-foreground">{p.strategy}</div>
                    </div>
                    <div className="text-right">
                      <div className="text-[10px] uppercase tracking-widest text-muted-foreground">Combined</div>
                      <div className="text-lg font-bold tabular-nums">{(p.combinedProb * 100).toFixed(1)}%</div>
                      <div className="text-[10px] text-muted-foreground">fair odds {p.fairAmericanOdds}</div>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="mb-3 flex flex-wrap gap-4 text-xs">
                      <span><b>Legs:</b> {p.legs.length}</span>
                      <span><b>Break-even @ -120 legs:</b> {(p.breakEvenProb * 100).toFixed(1)}%</span>
                      <span>
                        <b>Edge:</b>{" "}
                        <span className={good ? "text-emerald-600 dark:text-emerald-400 font-semibold" : "text-destructive"}>
                          {good ? "+" : ""}{(edge * 100).toFixed(1)} pts
                        </span>
                      </span>
                      {good && <Badge className="bg-emerald-600 hover:bg-emerald-600">POSITIVE EDGE</Badge>}
                    </div>
                    <div className="overflow-x-auto">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Player</TableHead>
                            <TableHead>Market</TableHead>
                            <TableHead className="text-right">Leg %</TableHead>
                            <TableHead className="text-right">Conf</TableHead>
                            <TableHead>Reason</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {p.legs.map((l) => (
                            <TableRow key={l.predictionId}>
                              <TableCell className="font-medium">
                                {l.player}
                                {l.teamName && (
                                  <span className="ml-2 text-xs font-normal text-muted-foreground">({l.teamName})</span>
                                )}
                              </TableCell>
                              <TableCell>{MARKET_SHORT[l.market] ?? l.market}</TableCell>
                              <TableCell className="text-right tabular-nums">{(l.legProb * 100).toFixed(1)}%</TableCell>
                              <TableCell className="text-right tabular-nums">{Number(l.confidence).toFixed(0)}</TableCell>
                              <TableCell className="text-xs text-muted-foreground">{l.reason}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
            {customParlays.length === 0 && customHrParlays.length === 0 && customPicks.length > 0 && (
              <p className="text-center text-xs text-muted-foreground">
                Not enough picks across selected games to build a full parlay. Try selecting more games or check that analysis has been run.
              </p>
            )}
          </div>
        </div>
      )}

      {/* ── All-Day Parlays (existing) ──────────────────────────────── */}
      {selectedGamePks.size === 0 && (
        <>
      <div className="grid gap-4">
        {parlays.map((p) => {
          const edge = p.edge;
          const good = edge > 0;
          return (
            <Card key={p.name}>
              <CardHeader className="flex-row items-start justify-between space-y-0 pb-3">
                <div>
                  <CardTitle className="text-base font-bold">{p.name}</CardTitle>
                  <div className="mt-1 max-w-2xl text-xs text-muted-foreground">{p.strategy}</div>
                </div>
                <div className="text-right">
                  <div className="text-[10px] uppercase tracking-widest text-muted-foreground">Combined</div>
                  <div className="text-lg font-bold tabular-nums">{(p.combinedProb * 100).toFixed(1)}%</div>
                  <div className="text-[10px] text-muted-foreground">fair odds {p.fairAmericanOdds}</div>
                </div>
              </CardHeader>
              <CardContent>
                <div className="mb-3 flex flex-wrap gap-4 text-xs">
                  <span><b>Legs:</b> {p.legs.length}</span>
                  <span><b>Break-even @ -120 legs:</b> {(p.breakEvenProb * 100).toFixed(1)}%</span>
                  <span>
                    <b>Edge:</b>{" "}
                    <span className={good ? "text-emerald-600 dark:text-emerald-400 font-semibold" : "text-destructive"}>
                      {good ? "+" : ""}{(edge * 100).toFixed(1)} pts
                    </span>
                  </span>
                  {good && <Badge className="bg-emerald-600 hover:bg-emerald-600">POSITIVE EDGE</Badge>}
                </div>
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Player</TableHead>
                        <TableHead>Market</TableHead>
                        <TableHead className="text-right">Leg %</TableHead>
                        <TableHead className="text-right">Conf</TableHead>
                        <TableHead>Reason</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {p.legs.map((l) => (
                        <TableRow key={l.predictionId}>
                          <TableCell className="font-medium">
                            {l.player}
                            {l.teamName && (
                              <span className="ml-2 text-xs font-normal text-muted-foreground">({l.teamName})</span>
                            )}
                          </TableCell>
                          <TableCell>{MARKET_SHORT[l.market] ?? l.market}</TableCell>
                          <TableCell className="text-right tabular-nums">{(l.legProb * 100).toFixed(1)}%</TableCell>
                          <TableCell className="text-right tabular-nums">{Number(l.confidence).toFixed(0)}</TableCell>
                          <TableCell className="text-xs text-muted-foreground">{l.reason}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {data?.note && parlays.length > 0 && (
        <p className="mt-6 text-center text-xs text-muted-foreground">{data.note}</p>
      )}

      {hrParlays.length > 0 && (
        <div className="mt-10">
          <div className="mb-4">
            <div className="text-xs uppercase tracking-widest text-muted-foreground">Concentrated</div>
            <h2 className="text-2xl font-black tracking-tight">HR prospect parlays</h2>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
              2-3 leg parlays built purely from our top home run confidence scores — same model, no Vegas input.
            </p>
          </div>
          <div className="grid gap-4">
            {hrParlays.map((p) => {
              const good = p.edge > 0;
              return (
                <Card key={p.name}>
                  <CardHeader className="flex-row items-start justify-between space-y-0 pb-3">
                    <div>
                      <CardTitle className="text-base font-bold">{p.name}</CardTitle>
                      <div className="mt-1 max-w-2xl text-xs text-muted-foreground">{p.strategy}</div>
                    </div>
                    <div className="text-right">
                      <div className="text-[10px] uppercase tracking-widest text-muted-foreground">Combined</div>
                      <div className="text-lg font-bold tabular-nums">{(p.combinedProb * 100).toFixed(1)}%</div>
                      <div className="text-[10px] text-muted-foreground">fair odds {p.fairAmericanOdds}</div>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="mb-3 flex flex-wrap gap-4 text-xs">
                      <span><b>Legs:</b> {p.legs.length}</span>
                      <span><b>Break-even @ -120 legs:</b> {(p.breakEvenProb * 100).toFixed(1)}%</span>
                      <span>
                        <b>Edge:</b>{" "}
                        <span className={good ? "text-emerald-600 dark:text-emerald-400 font-semibold" : "text-destructive"}>
                          {good ? "+" : ""}{(p.edge * 100).toFixed(1)} pts
                        </span>
                      </span>
                      {good && <Badge className="bg-emerald-600 hover:bg-emerald-600">POSITIVE EDGE</Badge>}
                    </div>
                    <div className="overflow-x-auto">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Player</TableHead>
                            <TableHead className="text-right">HR %</TableHead>
                            <TableHead className="text-right">Conf</TableHead>
                            <TableHead>Reason</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {p.legs.map((l) => (
                            <TableRow key={l.predictionId}>
                              <TableCell className="font-medium">
                                {l.player}
                                {l.teamName && (
                                  <span className="ml-2 text-xs font-normal text-muted-foreground">({l.teamName})</span>
                                )}
                              </TableCell>
                              <TableCell className="text-right tabular-nums">{(l.legProb * 100).toFixed(1)}%</TableCell>
                              <TableCell className="text-right tabular-nums">{Number(l.confidence).toFixed(0)}</TableCell>
                              <TableCell className="text-xs text-muted-foreground">{l.reason}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </div>
      )}
        </>
      )}
    </AppShell>
  );
}