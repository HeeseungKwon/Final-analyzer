const db = globalThis.__B44_DB__ || { auth:{ isAuthenticated: async()=>false, me: async()=>null }, entities:new Proxy({}, { get:()=>({ filter:async()=>[], get:async()=>null, create:async()=>({}), update:async()=>({}), delete:async()=>({}) }) }), integrations:{ Core:{ UploadFile:async()=>({ file_url:'' }) } } };

import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import AppShell from "@/components/mlb/AppShell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { buildParlays, buildHRParlays } from "@/lib/parlays";

const MARKET_SHORT = {
  hit_1: "1+ Hit",
  hit_2: "2+ Hits",
  hrr: "HRR 1.5",
  total_bases: "TB 1.5",
  home_run: "HR",
  strikeouts: "K 5.5",
};

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function Parlays() {
  const [date, setDate] = useState(todayStr());

  const { data, isLoading } = useQuery({
    queryKey: ["parlays", date],
    queryFn: async () => {
      const predictions = await db.entities.Prediction.filter({ game_date: date });
      const parlays = buildParlays(predictions);
      const hrParlays = buildHRParlays(predictions);
      return { parlays, hrParlays, note: parlays.length === 0 ? "No parlays available. Run today's analysis on the Today page first." : "Parlays are algorithmic suggestions from your own model — not betting advice. All legs must hit for a parlay to win." };
    },
  });

  const parlays = data?.parlays ?? [];
  const hrParlays = data?.hrParlays ?? [];

  return (
    <AppShell>
      <div className="mb-6 flex items-end justify-between">
        <div>
          <div className="text-xs uppercase tracking-widest text-muted-foreground">Portfolio</div>
          <h1 className="text-3xl font-black tracking-tight">Daily parlays</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Five 4-6 leg parlays built from today's projections. Each uses a different strategy — safety, balance, pitcher lean, slugger stack, high-leverage — and diversifies across games and players (max 1 leg per player, max 2 per game). Every leg has a modeled hit probability; the combined product plus break-even at typical -120 juice tells you the edge.
          </p>
        </div>
        <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-40" />
      </div>

      {isLoading && <div className="py-10 text-center text-muted-foreground">Loading…</div>}
      {!isLoading && parlays.length === 0 && (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            {data?.note ?? "No parlays available. Run today's analysis on the Today page first."}
          </CardContent>
        </Card>
      )}

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
                          <TableCell className="font-medium">{l.player}</TableCell>
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
                              <TableCell className="font-medium">{l.player}</TableCell>
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
    </AppShell>
  );
}