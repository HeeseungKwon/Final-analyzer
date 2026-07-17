const db = globalThis.__B44_DB__ || { auth:{ isAuthenticated: async()=>false, me: async()=>null }, entities:new Proxy({}, { get:()=>({ filter:async()=>[], get:async()=>null, create:async()=>({}), update:async()=>({}), delete:async()=>({}) }) }), integrations:{ Core:{ UploadFile:async()=>({ file_url:'' }) } } };

import React, { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import AppShell from "@/components/mlb/AppShell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { buildParlays, buildHRParlays, buildCustomParlay as buildCustomParlayFn } from "@/lib/parlays";
import { recalculateParlayStatus } from "@/lib/utils/parlaySync";
import { getMarketLabel, getRecommendationMarketPriority, isCoreHitterMarket } from "@/lib/constants/markets";
import { augmentPredictionsWithZScores } from "@/lib/recommendations";
import { computePickGrade, gradeColorClass } from "@/lib/utils/pickGrade";

const DAILY_PARLAYS_KEY = "dailyParlays_v1";

let _idSeq = 0;
function genId(prefix) {
  _idSeq += 1;
  return `${prefix}-${Date.now()}-${_idSeq}`;
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function comparePicksByPriority(a, b) {
  // First prioritize markets (HRR_2, HRR_3, HIT_2, TOTAL_BASES, etc.)
  const marketCmp = getRecommendationMarketPriority(a.market) - getRecommendationMarketPriority(b.market);
  if (marketCmp !== 0) return marketCmp;
  
  // Within same market, sort by z-score if available (normalized comparison within market)
  const hasZScores = Number.isFinite(a.z_score) && Number.isFinite(b.z_score);
  if (hasZScores) {
    return (b.z_score ?? 0) - (a.z_score ?? 0);
  }
  
  // Fallback to rec_score (which stores confidence) if z-scores not available
  return (
    (b.rec_score ?? 0) - (a.rec_score ?? 0) ||
    (b.confidence ?? 0) - (a.confidence ?? 0) ||
    String(a.player_name ?? "").localeCompare(String(b.player_name ?? ""))
  );
}

function formatProjectionForMarket(projection) {
  return `${(Number(projection ?? 0) * 100).toFixed(1)}%`;
}

function ParlayCard({ parlay, selectable, selected, onToggle, onDelete }) {
  const good = parlay.hasLiveOdds && parlay.edge > 0;
  return (
    <Card className={selected ? "border-primary bg-primary/5" : ""}>
      <CardHeader className="flex-row items-start justify-between space-y-0 pb-3">
        <div className="flex items-center gap-3">
          {selectable && (
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 accent-primary shrink-0"
              checked={!!selected}
              onChange={() => onToggle?.(parlay)}
            />
          )}
          <div>
            <CardTitle className="text-base font-bold">{parlay.name}</CardTitle>
            <div className="mt-1 max-w-2xl text-xs text-muted-foreground">{parlay.strategy}</div>
          </div>
        </div>
        <div className="flex items-start gap-2">
          <div className="text-right">
            <div className="text-[10px] uppercase tracking-widest text-muted-foreground">Combined</div>
            <div className="text-lg font-bold tabular-nums">{(parlay.combinedProb * 100).toFixed(1)}%</div>
            <div className="text-[10px] text-muted-foreground">fair odds {parlay.fairAmericanOdds}</div>
          </div>
          {onDelete && (
            <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground hover:text-destructive" onClick={() => onDelete(parlay)}>
              ×
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <div className="mb-3 flex flex-wrap gap-4 text-xs">
          <span><b>Legs:</b> {parlay.legs.length}</span>
          <span><b>Break-even @ -120 legs:</b> {(parlay.breakEvenProb * 100).toFixed(1)}%</span>
          <span><b>EV:</b> {parlay.hasLiveOdds && Number.isFinite(parlay.ev) ? `${(parlay.ev * 100).toFixed(1)}%` : "N/A"}</span>
          {Number.isFinite(parlay.correlation) && <span><b>Correlation:</b> {(parlay.correlation * 100).toFixed(1)}%</span>}
          <span>
            <b>Edge:</b>{" "}
            <span className={good ? "text-emerald-600 dark:text-emerald-400 font-semibold" : "text-destructive"}>
              {parlay.hasLiveOdds && Number.isFinite(parlay.edge) ? `${good ? "+" : ""}${(parlay.edge * 100).toFixed(1)} pts` : "N/A"}
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
                 <TableHead>Reason</TableHead>
               </TableRow>
            </TableHeader>
            <TableBody>
              {parlay.legs.map((l) => (
                <TableRow key={l.predictionId}>
                  <TableCell className="font-medium">
                    {l.player}
                    {l.teamName && <span className="ml-2 text-xs font-normal text-muted-foreground">({l.teamName})</span>}
                  </TableCell>
                  <TableCell>{getMarketLabel(l.market, "short")}</TableCell>
                   <TableCell className="text-right tabular-nums">{(l.legProb * 100).toFixed(1)}%</TableCell>
                   <TableCell className="text-xs text-muted-foreground">{l.reason}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

export default function Parlays() {
  const [date, setDate] = useState(todayStr());
  const [selectedGamePks, setSelectedGamePks] = useState(new Set());
  const [customSelectedPickIds, setCustomSelectedPickIds] = useState(new Set());
  const [userCustomParlays, setUserCustomParlays] = useState([]);
  const [selectedAnalyzerParlayNames, setSelectedAnalyzerParlayNames] = useState(new Set());
  const [selectedCustomParlayIds, setSelectedCustomParlayIds] = useState(new Set());
  const [dailyParlays, setDailyParlays] = useState([]);
  const [saveMessage, setSaveMessage] = useState("");

  // Load saved daily parlays from localStorage on mount
  React.useEffect(() => {
    try {
      const saved = localStorage.getItem(DAILY_PARLAYS_KEY);
      if (saved) setDailyParlays(JSON.parse(saved));
    } catch {}
  }, []);

  // Reset per-date state when date changes
  React.useEffect(() => {
    setSelectedGamePks(new Set());
    setCustomSelectedPickIds(new Set());
    setUserCustomParlays([]);
    setSelectedAnalyzerParlayNames(new Set());
    setSelectedCustomParlayIds(new Set());
  }, [date]);

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
      return { games, eligiblePredictions };
    },
  });

  const games = data?.games ?? [];
  const eligiblePredictions = data?.eligiblePredictions ?? [];

  // All recommended picks from selected games, sorted with core hitter markets first.
  const allPicksForGames = useMemo(
    () => {
      const filtered = eligiblePredictions
        .filter((p) => selectedGamePks.has(p.game_pk) && p.recommended && Number(p.projection ?? 0) >= 0.60);
      
      // Augment with z-scores for market-normalized ranking
      augmentPredictionsWithZScores(filtered);
      
      return filtered.sort(comparePicksByPriority);
    },
    [eligiblePredictions, selectedGamePks]
  );

  const corePicksForGames = useMemo(
    () => allPicksForGames.filter((p) => isCoreHitterMarket(p.market)),
    [allPicksForGames]
  );

  const homeRunPicksForGames = useMemo(
    () => allPicksForGames.filter((p) => p.market === "home_run"),
    [allPicksForGames]
  );

  const otherPicksForGames = useMemo(
    () => allPicksForGames.filter((p) => !isCoreHitterMarket(p.market) && p.market !== "home_run"),
    [allPicksForGames]
  );

  // Analyzer-generated parlays for selected games
  const analyzerParlays = useMemo(
    () => {
      const regularParlays = buildParlays(eligiblePredictions, selectedGamePks);
      const hrParlays = selectedGamePks.size >= 2 ? buildHRParlays(eligiblePredictions, selectedGamePks) : [];
      return [...regularParlays, ...hrParlays];
    },
    [eligiblePredictions, selectedGamePks]
  );

  function renderRecommendedPicksTable(picks) {
    return (
      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8"></TableHead>
                  <TableHead>Player</TableHead>
                   <TableHead>Team</TableHead>
                   <TableHead>Market</TableHead>
                   <TableHead className="text-right">Proj</TableHead>
                   <TableHead className="text-right">Edge Grade</TableHead>
                   <TableHead className="text-right">Edge</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {picks.map((p) => {
                  const picked = customSelectedPickIds.has(p.id);
                  const { letterGrade } = computePickGrade(p);
                  const edgePts = Number(p.rec_score);
                  return (
                    <TableRow
                      key={p.id}
                      className={`cursor-pointer hover:bg-muted/40 ${picked ? "bg-primary/5" : ""}`}
                      onClick={() => handlePickSelection(p.id)}
                    >
                      <TableCell>
                        <input
                          type="checkbox"
                          className="h-4 w-4 accent-primary"
                          checked={picked}
                          onChange={() => handlePickSelection(p.id)}
                          onClick={(e) => e.stopPropagation()}
                        />
                      </TableCell>
                      <TableCell className="font-medium">{p.player_name}</TableCell>
                       <TableCell className="text-xs text-muted-foreground">{p.team_name}</TableCell>
                       <TableCell>{getMarketLabel(p.market, "short")}</TableCell>
                       <TableCell className="text-right tabular-nums">
                         {formatProjectionForMarket(p.projection, p.market)}
                       </TableCell>
                      <TableCell className="text-right">
                        <span className={"inline-block rounded px-1.5 py-0.5 text-xs font-bold " + gradeColorClass(letterGrade)}>
                          {letterGrade}
                        </span>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {edgePts > 0 ? "+" : ""}{edgePts.toFixed(1)} pts
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    );
  }

  // ── Handlers ────────────────────────────────────────────────────────────

  function toggleGame(pk) {
    setSelectedGamePks((prev) => {
      const next = new Set(prev);
      next.has(pk) ? next.delete(pk) : next.add(pk);
      return next;
    });
    setCustomSelectedPickIds(new Set());
  }

  function selectAll() {
    setSelectedGamePks(new Set(games.map((g) => g.game_pk)));
    setCustomSelectedPickIds(new Set());
  }

  function clearAll() {
    setSelectedGamePks(new Set());
    setCustomSelectedPickIds(new Set());
  }

  function handlePickSelection(pickId) {
    setCustomSelectedPickIds((prev) => {
      const next = new Set(prev);
      next.has(pickId) ? next.delete(pickId) : next.add(pickId);
      return next;
    });
  }

  function handleBuildCustomParlay() {
    const selected = allPicksForGames.filter((p) => customSelectedPickIds.has(p.id));
    if (selected.length < 2) return;
    const parlay = buildCustomParlayFn(selected, `Custom #${userCustomParlays.length + 1}`);
    if (!parlay) return;
    const withId = { ...parlay, id: genId("custom") };
    setUserCustomParlays((prev) => [...prev, withId]);
    setCustomSelectedPickIds(new Set());
  }

  function handleDeleteCustomParlay(parlay) {
    setUserCustomParlays((prev) => prev.filter((p) => p.id !== parlay.id));
    setSelectedCustomParlayIds((prev) => {
      const next = new Set(prev);
      next.delete(parlay.id);
      return next;
    });
  }

  function toggleAnalyzerParlay(parlay) {
    setSelectedAnalyzerParlayNames((prev) => {
      const next = new Set(prev);
      next.has(parlay.name) ? next.delete(parlay.name) : next.add(parlay.name);
      return next;
    });
  }

  function toggleCustomParlay(parlay) {
    setSelectedCustomParlayIds((prev) => {
      const next = new Set(prev);
      next.has(parlay.id) ? next.delete(parlay.id) : next.add(parlay.id);
      return next;
    });
  }

  function handleSaveDailyParlays() {
    const now = new Date().toISOString();
    const toSave = [];
    const buildSavedParlay = (parlay, source) => {
      const {
        gameDate: _gameDate,
        savedAt: _savedAt,
        status: _status,
        completedLegs: _completedLegs,
        hitLegs: _hitLegs,
        missLegs: _missLegs,
        pendingLegs: _pendingLegs,
        totalLegs: _totalLegs,
        ...rest
      } = parlay;

      return recalculateParlayStatus({
        ...rest,
        id: genId("daily"),
        gameDate: date,
        savedAt: now,
        source,
      });
    };

    for (const p of analyzerParlays) {
      if (selectedAnalyzerParlayNames.has(p.name)) {
        toSave.push(buildSavedParlay(p, "analyzer"));
      }
    }

    for (const p of userCustomParlays) {
      if (selectedCustomParlayIds.has(p.id)) {
        toSave.push(buildSavedParlay(p, "custom"));
      }
    }

    if (toSave.length === 0) return;

    const updated = [...dailyParlays, ...toSave];
    setDailyParlays(updated);
    try { localStorage.setItem(DAILY_PARLAYS_KEY, JSON.stringify(updated)); } catch {}
    setSelectedAnalyzerParlayNames(new Set());
    setSelectedCustomParlayIds(new Set());
    setSaveMessage(`✅ Saved ${toSave.length} parlay${toSave.length > 1 ? "s" : ""} to Accuracy Review!`);
    setTimeout(() => setSaveMessage(""), 4000);
  }

  const totalSelected = selectedAnalyzerParlayNames.size + selectedCustomParlayIds.size;

  return (
    <AppShell>
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="mb-6 flex items-end justify-between">
        <div>
          <div className="text-xs uppercase tracking-widest text-muted-foreground">Portfolio</div>
          <h1 className="text-3xl font-black tracking-tight">Daily Parlays</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Select games to generate parlays, build your own custom parlays, then save them to Accuracy Review.
          </p>
        </div>
        <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-40" />
      </div>

      {isLoading && <div className="py-10 text-center text-muted-foreground">Loading…</div>}

      {/* ── Section 1: Game Selection & Picks ─────────────────────────── */}
      {!isLoading && games.length === 0 && (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No games found for this date. Run today's analysis on the Today page first.
          </CardContent>
        </Card>
      )}

      {!isLoading && games.length > 0 && (
        <div className="mb-8">
          <div className="mb-3 flex items-center gap-3">
            <div>
              <div className="text-xs uppercase tracking-widest text-muted-foreground">Step 1</div>
              <h2 className="text-xl font-black tracking-tight">Select Games</h2>
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

          {/* Recommended Picks Table */}
          {selectedGamePks.size > 0 && (
            <div className="mt-6">
              <div className="mb-2 flex items-center justify-between">
                <div>
                  <div className="text-xs uppercase tracking-widest text-muted-foreground">Recommended picks</div>
                  <h3 className="text-lg font-bold tracking-tight">
                    {corePicksForGames.length} core hitter picks from {selectedGamePks.size} selected game{selectedGamePks.size > 1 ? "s" : ""}
                  </h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Main recommendations prioritize 2+ HRR, 3+ HRR, 2+ Hits, and TB O1.5. Home run picks are broken out separately below.
                  </p>
                </div>
                {customSelectedPickIds.size > 0 && (
                  <div className="text-xs text-muted-foreground">
                    {customSelectedPickIds.size} pick{customSelectedPickIds.size > 1 ? "s" : ""} selected for custom parlay
                  </div>
                )}
              </div>

              {allPicksForGames.length > 0 ? (
                <div className="space-y-6">
                  {corePicksForGames.length > 0 ? (
                    <div className="space-y-2">
                      <div>
                        <div className="text-xs uppercase tracking-widest text-muted-foreground">Core hitter recommendations</div>
                        <h4 className="text-base font-bold tracking-tight">Best HRR, hits, and total bases props</h4>
                      </div>
                      {renderRecommendedPicksTable(corePicksForGames)}
                    </div>
                  ) : (
                    <Card>
                      <CardContent className="py-6 text-center text-sm text-muted-foreground">
                        No core hitter recommendations were available for the selected game{selectedGamePks.size > 1 ? "s" : ""}.
                      </CardContent>
                    </Card>
                  )}

                  <div className="space-y-2">
                    <div>
                      <div className="text-xs uppercase tracking-widest text-muted-foreground">Best home run picks</div>
                      <h4 className="text-base font-bold tracking-tight">Dedicated HR opportunities</h4>
                    </div>
                    {homeRunPicksForGames.length > 0 ? (
                      renderRecommendedPicksTable(homeRunPicksForGames)
                    ) : (
                      <Card>
                        <CardContent className="py-6 text-center text-sm text-muted-foreground">
                          No recommended home run picks were available for the selected game{selectedGamePks.size > 1 ? "s" : ""}.
                        </CardContent>
                      </Card>
                    )}
                  </div>

                  {otherPicksForGames.length > 0 && (
                    <div className="space-y-2">
                      <div>
                        <div className="text-xs uppercase tracking-widest text-muted-foreground">Other recommended props</div>
                        <h4 className="text-base font-bold tracking-tight">Non-core markets still flagged by the model</h4>
                      </div>
                      {renderRecommendedPicksTable(otherPicksForGames)}
                    </div>
                  )}
                </div>
              ) : (
                <Card>
                  <CardContent className="py-6 text-center text-sm text-muted-foreground">
                    No recommended picks for the selected game{selectedGamePks.size > 1 ? "s" : ""}. Try running analysis on the Today page.
                  </CardContent>
                </Card>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Sections 2A, Save button, 2B: only when games are selected ── */}
      {selectedGamePks.size > 0 && (
        <>
          {/* Section 2A: Analyzer-Generated Parlays */}
          <div className="mb-8">
            <div className="mb-4">
              <div className="text-xs uppercase tracking-widest text-muted-foreground">Step 2A</div>
              <h2 className="text-2xl font-black tracking-tight">Analyzer-Generated Parlays</h2>
              <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
                Parlays built automatically from the {selectedGamePks.size} selected game{selectedGamePks.size > 1 ? "s" : ""}: one mixed 4-leg card with exactly one HR leg, one all-core 4-leg card, and one all-core 5-leg card.
              </p>
            </div>

            {analyzerParlays.length > 0 ? (
              <div className="grid gap-4">
                {analyzerParlays.map((p) => (
                  <ParlayCard
                    key={p.name}
                    parlay={p}
                    selectable
                    selected={selectedAnalyzerParlayNames.has(p.name)}
                    onToggle={toggleAnalyzerParlay}
                  />
                ))}
              </div>
            ) : (
              <Card>
                <CardContent className="py-6 text-center text-sm text-muted-foreground">
                  Not enough recommended core hitter props were available across the selected games to build the required 4-leg and 5-leg cards.
                </CardContent>
              </Card>
            )}
          </div>

          {/* ── Save Parlays for the Day button ──────────────────────── */}
          <div className="mb-8 flex flex-col items-center gap-2">
            <Button
              size="lg"
              className="px-10 text-base font-bold"
              disabled={totalSelected === 0}
              onClick={handleSaveDailyParlays}
            >
              📌 Save Parlays for the Day {totalSelected > 0 ? `(${totalSelected} selected)` : ""}
            </Button>
            {saveMessage && (
              <p className="text-sm font-medium text-emerald-600 dark:text-emerald-400">{saveMessage}</p>
            )}
            {totalSelected === 0 && (
              <p className="text-xs text-muted-foreground">Select parlays above or below to save them to Accuracy Review</p>
            )}
          </div>

          {/* Section 2B: My Custom Parlays */}
          <div className="mb-8">
            <div className="mb-4 flex items-start justify-between">
              <div>
                <div className="text-xs uppercase tracking-widest text-muted-foreground">Step 2B</div>
                <h2 className="text-2xl font-black tracking-tight">My Custom Parlays</h2>
                <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
                  Select picks from the table above, then click the button to build your own parlay.
                </p>
              </div>
              <Button
                onClick={handleBuildCustomParlay}
                disabled={customSelectedPickIds.size < 2}
                className="mt-1 shrink-0"
              >
                Build Custom Parlay
                {customSelectedPickIds.size >= 2 ? ` (${customSelectedPickIds.size} picks)` : ""}
              </Button>
            </div>

            {customSelectedPickIds.size > 0 && customSelectedPickIds.size < 2 && (
              <p className="mb-3 text-xs text-muted-foreground">Select at least 2 picks from the table above to build a custom parlay.</p>
            )}

            {userCustomParlays.length > 0 ? (
              <div className="grid gap-4">
                {userCustomParlays.map((p) => (
                  <ParlayCard
                    key={p.id}
                    parlay={p}
                    selectable
                    selected={selectedCustomParlayIds.has(p.id)}
                    onToggle={toggleCustomParlay}
                    onDelete={handleDeleteCustomParlay}
                  />
                ))}
              </div>
            ) : (
              <Card>
                <CardContent className="py-6 text-center text-sm text-muted-foreground">
                  No custom parlays yet. Select picks from the table above and click "Build Custom Parlay".
                </CardContent>
              </Card>
            )}
          </div>
        </>
      )}

    </AppShell>
  );
}
