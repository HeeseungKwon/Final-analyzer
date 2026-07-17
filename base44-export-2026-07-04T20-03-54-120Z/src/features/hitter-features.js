import { parkFactorFor } from "@/models/hitter-model";

export function buildHitterFeatures(data, game) {
  const team = data.teamStats ?? {};
  const opponentPitcher = data.opponentPitcher ?? {};
  const starterExpectedIP = opponentPitcher.gs > 0 && opponentPitcher.ip != null
    ? opponentPitcher.ip / opponentPitcher.gs
    : null;
  const derivedFeatures = data.derivedFeatures ?? data.derived ?? Object.fromEntries(
    ["ContactScore", "PowerScore", "QualityOfContact", "PlateDiscipline", "MatchupScore", "OpportunityScore", "RunEnvironment", "RecentForm", "FatigueAdjustment", "BullpenAdjustment"]
      .filter((key) => data[key] != null)
      .map((key) => [key, data[key]])
  );

  return {
    season: data.season,
    recent: data.recent,
    split: data.split,
    // Venue-specific weather and handedness park factors are not returned by
    // the current Stats API adapter; keep the verified park table as fallback.
    park: { factor: parkFactorFor(game.home_team_id) },
    // Keep the legacy field populated for consumers that display raw feature
    // context; the simulation uses the richer estimate from scoring.js.
    expectedPA: lineupPA(data.player.battingOrder),
    teamContext: {
      obp: team.obp ?? 0.32,
      runsPerGame: team.runsPerGame ?? 4.5,
    },
    opponentPitcher,
    opponentStarterExpectedIP: starterExpectedIP,
    // The Python derived layer can supply these when an upstream caller has
    // already joined it; absent values are deliberately left unavailable.
    derivedFeatures,
    battingOrder: data.player.battingOrder,
  };
}

function lineupPA(order) { if (order <= 2) return 4.5; if (order <= 5) return 4.2; if (order <= 7) return 3.9; return 3.6; }
