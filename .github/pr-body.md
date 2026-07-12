## Summary

Integrates **SportsGameOdds** as the primary sportsbook odds provider, replacing placeholder implied probabilities with real market data. All existing scoring systems (Monte Carlo, Confidence, Projection Score, Edge, EV, Kelly, ROI, Parlays) are **unchanged** — only the sportsbook probability source is updated.

---

## Changes

### `src/lib/sportsbook-api.js`
- SportsGameOdds added as **priority #1** in the odds provider chain (above RapidAPI and ESPN)
- Authentication via `x-api-key` header using `VITE_SPORTSGAMEODDS_API_KEY` env var — never hardcoded
- Odds fetched **per game (event-level)**, never player-by-player — one API call per game covers all player lookups
- `SGO_MARKET_MAP` maps internal keys (`hit_2`, `home_run`, etc.) to SGO `statID` values
- **localStorage snapshot layer**: each game's full SGO response is saved under `sgo_snapshot:<YYYY-MM-DD>`; reused for the entire day with zero additional API calls; a new calendar day automatically creates a new snapshot
- Exports `getSnapshotMeta(dateStr)` for UI display and `refreshSnapshot(dateStr)` for manual reset

### `src/lib/analysis-runner.js`
- `runAnalysis(dateArg, onProgress, opts)` now accepts `opts = { refreshOdds: boolean }`
- Both `fetchRealtimeOdds()` call sites (hitters + pitchers) pass `{ refreshOdds }` through

### `src/pages/Today.jsx`
- New **Sportsbook Odds Snapshot** card showing: Snapshot Date, First Fetched, Last Updated, Sportsbooks Included
- **Toggle**: Refresh odds on next run (default OFF — uses cached snapshot)
- **Button**: Refresh Today's Sportsbook Odds — clears snapshot immediately and arms the toggle
- Toggle auto-resets to OFF after a successful refresh run

---

## Snapshot workflow

```
Run Analysis
    |
    v
Is today's snapshot in localStorage?
    |
    +-- YES (refreshOdds = OFF)  -->  Use cached event data  -->  No API call
    |
    +-- NO  (or refreshOdds = ON)
            --> Fetch SGO events list -> match game -> fetch full event props
                    --> Save to localStorage snapshot -> continue analysis

Tomorrow -> new date key -> snapshot miss -> fresh download automatically
```

---

## Setup

Add to `.env.local`:
```
VITE_SPORTSGAMEODDS_API_KEY=your_key_here
```
