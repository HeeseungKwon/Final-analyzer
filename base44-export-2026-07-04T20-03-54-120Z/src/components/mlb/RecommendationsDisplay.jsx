import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getMarketLabel, getMarketEmoji, getRecommendationMarketsInOrder } from "@/lib/constants/markets";
import { generateRecommendations, filterRecommendedPicks } from "@/lib/recommendations";

/**
 * RecommendationsDisplay
 * 
 * Displays market-specific and overall best picks using z-score normalization
 */
export default function RecommendationsDisplay({ predictions = [], title = "Best Picks" }) {
  // Filter to recommended picks with minimum projection
  const filtered = filterRecommendedPicks(predictions, {
    minConfidence: 0,
    minProjection: 0,
  });

  if (filtered.length === 0) {
    return null;
  }

  // Generate recommendations with market-specific rankings
  const { overallBestPicks, marketSpecificRankings } = generateRecommendations(filtered, {
    topN: 10,
  });

  // Get market order for display
  const marketOrder = getRecommendationMarketsInOrder();

  return (
    <div className="space-y-6">
      {/* Overall Best Picks Section */}
      {overallBestPicks.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-bold">
              ⭐ Overall Best Picks
            </CardTitle>
            <p className="mt-2 text-xs text-muted-foreground">
              Top picks ranked by normalized z-score across all markets. Elite performers in each market compete fairly regardless of market difficulty.
            </p>
          </CardHeader>
          <CardContent>
            <PicksTable picks={overallBestPicks} />
          </CardContent>
        </Card>
      )}

      {/* Market-Specific Sections */}
      {marketOrder.map((marketKey) => {
        const picks = marketSpecificRankings[marketKey];
        if (!picks || picks.length === 0) return null;

        const emoji = getMarketEmoji(marketKey);
        const label = getMarketLabel(marketKey);
        const displayTitle = `${emoji} Best ${label} Picks`;

        return (
          <Card key={marketKey}>
            <CardHeader className="pb-3">
              <CardTitle className="text-base font-bold">{displayTitle}</CardTitle>
            </CardHeader>
            <CardContent>
              <PicksTable picks={picks} showZScore={true} />
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

/**
 * PicksTable - Display picks in a table format
 */
function PicksTable({ picks = [], showZScore = false }) {
  if (picks.length === 0) {
    return (
      <div className="py-4 text-center text-xs text-muted-foreground">
        No picks available
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-8 text-center">#</TableHead>
            <TableHead>Player</TableHead>
            <TableHead>Team</TableHead>
            <TableHead>Market</TableHead>
            <TableHead className="text-right">Confidence</TableHead>
            {showZScore && <TableHead className="text-right">Z-Score</TableHead>}
            <TableHead className="text-right">Projection</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {picks.map((pick, idx) => (
            <TableRow key={pick.id || `${pick.player_name}-${pick.market}-${idx}`}>
              <TableCell className="text-center text-xs font-semibold text-muted-foreground">
                {idx + 1}
              </TableCell>
              <TableCell className="font-medium">{pick.player_name}</TableCell>
              <TableCell className="text-xs text-muted-foreground">{pick.team_name}</TableCell>
              <TableCell>
                <Badge variant="outline" className="text-xs">
                  {getMarketLabel(pick.market, "short")}
                </Badge>
              </TableCell>
              <TableCell className="text-right tabular-nums">
                <span className="font-semibold">{pick.confidence}%</span>
              </TableCell>
              {showZScore && (
                <TableCell className="text-right tabular-nums">
                  <span className={pick.z_score >= 0 ? "text-emerald-600" : "text-red-600"}>
                    {pick.z_score ? pick.z_score.toFixed(2) : "—"}
                  </span>
                </TableCell>
              )}
              <TableCell className="text-right tabular-nums">
                {(Number(pick.projection) * 100).toFixed(1)}%
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
