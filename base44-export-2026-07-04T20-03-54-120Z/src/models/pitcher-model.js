import { scorePitcher as legacyScorePitcher } from "@/lib/scoring";
export function scorePitcher(features, name = "") { return legacyScorePitcher(name, { season: features.season, oppTeamK: features.opponentTeam?.k_percent, expectedIP: features.expectedIP }); }
