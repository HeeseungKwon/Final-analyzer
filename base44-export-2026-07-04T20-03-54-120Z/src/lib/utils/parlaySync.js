const RESULT_PENDING = "pending";
const RESULT_HIT = "hit";
const RESULT_MISS = "miss";

function normalizeResult(result) {
  if (result === true || result === RESULT_HIT) return RESULT_HIT;
  if (result === false || result === RESULT_MISS) return RESULT_MISS;
  return RESULT_PENDING;
}

function normalizeLeg(leg = {}) {
  return {
    ...leg,
    result: normalizeResult(leg.result),
  };
}

function normalizeDate(value) {
  if (!value) return null;
  if (typeof value === "string") {
    return value.slice(0, 10);
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString().slice(0, 10);
}

function datesMatch(parlay, pick) {
  const parlayDate = normalizeDate(parlay?.gameDate);
  const pickDate = normalizeDate(pick?.game_date ?? pick?.gameDate);
  if (!parlayDate || !pickDate) return false;
  return parlayDate === pickDate;
}

function legMatchesPick(leg, pick) {
  if (leg?.predictionId != null && pick?.id != null && leg.predictionId === pick.id) {
    return true;
  }

  const legPlayerId = leg?.playerId ?? leg?.player_id;
  const pickPlayerId = pick?.player_id ?? pick?.playerId;
  if (legPlayerId == null || pickPlayerId == null || legPlayerId !== pickPlayerId) {
    return false;
  }

  if (leg?.market !== pick?.market) {
    return false;
  }

  if (leg?.gamePk != null && (pick?.game_pk ?? pick?.gamePk) != null) {
    return leg.gamePk === (pick.game_pk ?? pick.gamePk);
  }

  return true;
}

export function matchPickToParlay(pick, parlayLegs = []) {
  return parlayLegs.find((leg) => legMatchesPick(leg, pick)) ?? null;
}

export function updateLegResult(leg, result) {
  return {
    ...leg,
    result: normalizeResult(result),
  };
}

export function recalculateParlayStatus(parlay) {
  const legs = (parlay?.legs ?? []).map(normalizeLeg);

  let hitLegs = 0;
  let missLegs = 0;

  for (const leg of legs) {
    if (leg.result === RESULT_HIT) hitLegs += 1;
    if (leg.result === RESULT_MISS) missLegs += 1;
  }

  const totalLegs = legs.length;
  const completedLegs = hitLegs + missLegs;
  const pendingLegs = Math.max(0, totalLegs - completedLegs);
  const legacyStatus = parlay?.status;

  let status = RESULT_PENDING;
  if (missLegs > 0) {
    status = "lost";
  } else if (totalLegs > 0 && hitLegs === totalLegs) {
    status = "won";
  } else if (completedLegs > 0) {
    status = "inProgress";
  } else if (legacyStatus === "won" || legacyStatus === "lost") {
    status = legacyStatus;
  }

  return {
    ...parlay,
    legs,
    status,
    totalLegs,
    completedLegs,
    hitLegs,
    missLegs,
    pendingLegs,
  };
}

export function syncParlayWithResults(parlay, gameResults = []) {
  const nextLegs = (parlay?.legs ?? []).map((leg) => {
    const match = gameResults.find((pick) => {
      if (leg?.predictionId != null && pick?.id != null && leg.predictionId === pick.id) {
        return true;
      }

      const legGamePk = leg?.gamePk ?? null;
      const pickGamePk = pick?.game_pk ?? pick?.gamePk ?? null;
      if (legGamePk != null && pickGamePk != null) {
        return legGamePk === pickGamePk && legMatchesPick(leg, pick);
      }

      return datesMatch(parlay, pick) && legMatchesPick(leg, pick);
    });

    if (!match?.graded) {
      return normalizeLeg(leg);
    }
    return updateLegResult(leg, match.hit === true ? RESULT_HIT : RESULT_MISS);
  });

  return recalculateParlayStatus({
    ...parlay,
    legs: nextLegs,
  });
}

export function syncAllParlays(savedParlays = [], allResults = []) {
  return savedParlays.map((parlay) => syncParlayWithResults(parlay, allResults));
}
