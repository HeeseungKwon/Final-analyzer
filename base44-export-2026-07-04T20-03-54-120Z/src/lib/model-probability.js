export function getStoredModelProbability(market, projection) {
  const projectionValue = Number(projection);
  if (market === "strikeouts") return null;
  if (!Number.isFinite(projectionValue) || projectionValue < 0 || projectionValue > 1) return null;
  return projectionValue;
}

export function getDisplayModelProbability({ market, projection, explicitModelProbability }) {
  const explicitValue = Number(explicitModelProbability);
  if (Number.isFinite(explicitValue)) return explicitValue;
  return getStoredModelProbability(market, projection);
}
