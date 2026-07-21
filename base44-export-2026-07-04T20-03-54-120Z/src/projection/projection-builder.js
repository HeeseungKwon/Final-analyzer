function buildStoredFeatures(features, score) {
  const baseFeatures = features && typeof features === "object" ? features : {};
  const scoreFeatures = score?.features && typeof score.features === "object" ? score.features : {};
  const projectionValue = Number(score?.projection);

  return {
    ...baseFeatures,
    ...scoreFeatures,
    modelProbability:
      score?.market !== "strikeouts" && Number.isFinite(projectionValue) && projectionValue >= 0 && projectionValue <= 1
        ? projectionValue
        : null,
    confidenceScore: Number.isFinite(Number(score?.confidence)) ? Number(score.confidence) : null,
  };
}

export function buildPrediction({ game, player, playerType, score, features, date }) {
  return {
    game_pk: game.game_pk,
    game_date: date,
    player_id: player.id,
    player_name: player.fullName,
    team_id: player.teamId,
    team_name: player.teamName,
    player_type: playerType,
    market: score.market,
    confidence: Math.round(score.confidence),
    projection: score.projection,
    floor: score.floor,
    ceiling: score.ceiling,
    trigger_text: score.trigger ?? "",
    trigger_strength: score.triggerStrength ?? 0,
    features: JSON.stringify(buildStoredFeatures(features, score)),
    data_quality: score.dataQuality,
    recommended: score.confidence >= 60,
    rec_score: Math.round(score.confidence * 100) / 100,
    verdict: score.confidence >= 75 ? "strong" : score.confidence >= 60 ? "middling" : "fade",
    verdict_note: `${score.market}: ${(Number(score.projection) * 100).toFixed(1)}% projected`,
  };
}
