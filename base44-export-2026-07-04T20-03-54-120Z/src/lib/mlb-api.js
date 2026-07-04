// MLB Stats API helpers. Public JSON, no key required.
const BASE = "https://statsapi.mlb.com/api/v1";

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`MLB API ${res.status} ${url}`);
  return res.json();
}

export function todayIsoDate() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function currentMlbSeason(date = new Date()) {
  return date.getMonth() >= 1 ? date.getFullYear() : date.getFullYear() - 1;
}

export async function fetchSchedule(date) {
  const url = `${BASE}/schedule?sportId=1&date=${date}&hydrate=probablePitcher,team,venue`;
  const data = await fetchJson(url);
  const games = [];
  for (const d of data.dates ?? []) {
    for (const g of d.games ?? []) {
      games.push({
        game_pk: g.gamePk,
        game_date: date,
        game_time_utc: g.gameDate ?? null,
        home_team_id: g.teams?.home?.team?.id,
        home_team_name: g.teams?.home?.team?.name,
        away_team_id: g.teams?.away?.team?.id,
        away_team_name: g.teams?.away?.team?.name,
        venue_name: g.venue?.name ?? null,
        home_probable_pitcher_id: g.teams?.home?.probablePitcher?.id ?? null,
        home_probable_pitcher_name: g.teams?.home?.probablePitcher?.fullName ?? null,
        away_probable_pitcher_id: g.teams?.away?.probablePitcher?.id ?? null,
        away_probable_pitcher_name: g.teams?.away?.probablePitcher?.fullName ?? null,
        status: g.status?.detailedState ?? g.status?.abstractGameState ?? "Unknown",
        home_lineup: [],
        away_lineup: [],
        home_lineup_players: [],
        away_lineup_players: [],
      });
    }
  }
  return games;
}

export async function fetchPeople(ids) {
  if (ids.length === 0) return [];
  const out = [];
  const chunks = [];
  for (let i = 0; i < ids.length; i += 50) chunks.push(ids.slice(i, i + 50));
  for (const c of chunks) {
    const data = await fetchJson(`${BASE}/people?personIds=${c.join(",")}&hydrate=currentTeam`);
    for (const p of data.people ?? []) {
      out.push({
        id: p.id,
        fullName: p.fullName,
        primaryPosition: p.primaryPosition?.abbreviation ?? null,
        batSide: p.batSide?.code ?? null,
        pitchHand: p.pitchHand?.code ?? null,
      });
    }
  }
  return out;
}

function toNum(x, fallback = 0) {
  if (x == null) return fallback;
  const n = typeof x === "string" ? parseFloat(x) : Number(x);
  return isFinite(n) ? n : fallback;
}

const MLB_AND_MILB_SPORTS = [1, 11, 12, 13, 14, 16];
const SPORT_LABEL = { 1: "MLB", 11: "Triple-A", 12: "Double-A", 13: "High-A", 14: "Single-A", 16: "Rookie" };

async function fetchHitterStatSplit(personId, season, sportId, group, games, currentSeason) {
  let url;
  if (group === "career") {
    url = `${BASE}/people/${personId}/stats?stats=career&sportId=${sportId}&group=hitting`;
  } else if (group === "lastXGames") {
    url = `${BASE}/people/${personId}/stats?stats=lastXGames&limit=${games}&season=${season}&sportId=${sportId}&group=hitting`;
  } else {
    url = `${BASE}/people/${personId}/stats?stats=season&season=${season}&sportId=${sportId}&group=hitting`;
  }
  try {
    const data = await fetchJson(url);
    const split = data.stats?.[0]?.splits?.[0]?.stat;
    if (!split) return null;
    const pa = toNum(split.plateAppearances);
    if (pa === 0) return null;
    const isCurrentSeason = season === currentSeason && sportId === 1;
    return {
      pa,
      ab: toNum(split.atBats),
      hits: toNum(split.hits),
      doubles: toNum(split.doubles),
      triples: toNum(split.triples),
      home_runs: toNum(split.homeRuns),
      rbi: toNum(split.rbi),
      runs: toNum(split.runs),
      bb: toNum(split.baseOnBalls),
      so: toNum(split.strikeOuts),
      avg: toNum(split.avg),
      obp: toNum(split.obp),
      slg: toNum(split.slg),
      ops: toNum(split.ops),
      quality: isCurrentSeason ? "ok" : "partial",
      source: `${SPORT_LABEL[sportId] ?? `sport ${sportId}`} ${group === "career" ? "career" : season}`,
    };
  } catch {
    return null;
  }
}

export async function fetchHitterStats(personId, season) {
  for (const candidateSeason of [season, season - 1]) {
    for (const sportId of MLB_AND_MILB_SPORTS) {
      const stat = await fetchHitterStatSplit(personId, candidateSeason, sportId, "season", 15, season);
      if (stat && stat.pa > 0) return stat;
    }
  }
  // career fallback
  for (const sportId of MLB_AND_MILB_SPORTS) {
    const stat = await fetchHitterStatSplit(personId, undefined, sportId, "career");
    if (stat && stat.pa > 0) return { ...stat, quality: "partial" };
  }
  return null;
}

export async function fetchHitterRecent(personId, season, games = 15) {
  for (const candidateSeason of [season, season - 1]) {
    for (const sportId of MLB_AND_MILB_SPORTS) {
      const stat = await fetchHitterStatSplit(personId, candidateSeason, sportId, "lastXGames", games, season);
      if (stat && stat.pa > 0) return stat;
    }
  }
  return null;
}

export async function fetchPitcherStats(personId, season) {
  for (const candidateSeason of [season, season - 1]) {
    for (const sportId of MLB_AND_MILB_SPORTS) {
      let url = `${BASE}/people/${personId}/stats?stats=season&season=${candidateSeason}&sportId=${sportId}&group=pitching`;
      try {
        const data = await fetchJson(url);
        const split = data.stats?.[0]?.splits?.[0]?.stat;
        if (!split) continue;
        const ip = toNum(split.inningsPitched);
        const bf = toNum(split.battersFaced);
        if (bf === 0) continue;
        return {
          gs: toNum(split.gamesStarted),
          ip,
          so: toNum(split.strikeOuts),
          bb: toNum(split.baseOnBalls),
          hits_allowed: toNum(split.hits),
          hr_allowed: toNum(split.homeRuns),
          era: toNum(split.era),
          whip: toNum(split.whip),
          k_per_9: toNum(split.strikeoutsPer9Inn),
          k_percent: bf > 0 ? toNum(split.strikeOuts) / bf : 0,
          bf,
          quality: candidateSeason === season && sportId === 1 ? "ok" : "partial",
        };
      } catch {
        continue;
      }
    }
  }
  return null;
}

export async function fetchTeamPitchingK(teamId, season) {
  try {
    const data = await fetchJson(`${BASE}/teams/${teamId}/stats?stats=season&season=${season}&group=pitching`);
    const split = data.stats?.[0]?.splits?.[0]?.stat;
    if (!split) return null;
    const bf = toNum(split.battersFaced);
    return { k_percent: bf > 0 ? toNum(split.strikeOuts) / bf : 0 };
  } catch {
    return null;
  }
}

export async function fetchTeamHittingSO(teamId, season) {
  try {
    const data = await fetchJson(`${BASE}/teams/${teamId}/stats?stats=season&season=${season}&group=hitting`);
    const split = data.stats?.[0]?.splits?.[0]?.stat;
    if (!split) return null;
    const pa = toNum(split.plateAppearances);
    return { k_percent: pa > 0 ? toNum(split.strikeOuts) / pa : 0 };
  } catch {
    return null;
  }
}

export async function fetchBoxscore(gamePk) {
  try {
    const data = await fetchJson(`${BASE}/game/${gamePk}/boxscore`);
    return data;
  } catch {
    return null;
  }
}

export async function fetchGameLineup(gamePk) {
  try {
    const data = await fetchJson(`${BASE}/game/${gamePk}/boxscore`);
    const result = { home: [], away: [] };
    for (const side of ["home", "away"]) {
      const team = data.teams?.[side];
      if (!team?.players) continue;
      const starters = [];
      for (const key of Object.keys(team.players)) {
        const player = team.players[key];
        const bo = player.battingOrder;
        if (!bo) continue;
        const boNum = Number(bo);
        // Original starters have battingOrder values that are exact multiples
        // of 100 (100, 200, ... 900). Substitutes/pinch-hitters get a
        // non-zero sub-number appended (e.g. 101, 212) — skip those so only
        // the actual starting-9 lineup is analyzed.
        if (!boNum || boNum % 100 !== 0) continue;
        starters.push({
          id: player.person?.id,
          fullName: player.person?.fullName ?? `Player #${player.person?.id}`,
          battingOrder: boNum / 100,
          batSide: player.person?.batSide?.code ?? null,
          position: player.position?.abbreviation ?? null,
        });
      }
      starters.sort((a, b) => a.battingOrder - b.battingOrder);
      result[side] = starters.slice(0, 9);
    }
    return result;
  } catch {
    return { home: [], away: [] };
  }
}