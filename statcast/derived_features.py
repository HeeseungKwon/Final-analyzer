"""Derived-factor calculations for aggregated Statcast player data.

The formulas and weights mirror the supplied ``derived_factors.py``
specification.  This module adds only the adapter from the aggregator's
snake_case columns to those calculations; it does not fabricate external
inputs such as bullpen, park, weather, or team statistics.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

def compute_league_baseline(df: pd.DataFrame, columns: list) -> dict:
    baseline = {}
    for col in columns:
        if col in df.columns:
            baseline[col] = {"mean": df[col].mean(), "std": df[col].std(ddof=0) or 1e-6}
    return baseline


def z(player: dict, league: dict, col: str, invert: bool = False) -> float:
    val = player.get(col)
    if val is None or pd.isna(val) or col not in league or league[col]["std"] == 0:
        return 0.0
    value = (val - league[col]["mean"]) / league[col]["std"]
    return -value if invert else value


def weighted_z(player: dict, league: dict, weight_map: dict) -> float:
    return sum(w * z(player, league, col, invert=inv) for col, (w, inv) in weight_map.items())


def to_score(composite_z: float, spread: float = 15, center: float = 50) -> float:
    return float(np.clip(center + composite_z * spread, 0, 100))


def shrink(sample_value: float, baseline_value: float, n: int, k: float) -> float:
    if sample_value is None or pd.isna(sample_value):
        return baseline_value
    n = n or 0
    return (n / (n + k)) * sample_value + (k / (n + k)) * baseline_value


def zscore_to_score_inverse(score: float) -> float:
    return (score - 50) / 15


WEIGHTS = {
    "contact_score": {"k_pct": (0.30, True), "zone_contact_pct": (0.25, False), "whiff_pct": (0.20, True), "sweet_spot_pct": (0.15, False), "babip": (0.10, False)},
    "power_score": {"barrel_pct": (0.30, False), "hard_hit_pct": (0.20, False), "x_iso": (0.20, False), "avg_exit_velo": (0.15, False), "fb_pct": (0.10, False), "pull_pct": (0.05, False)},
    "quality_of_contact": {"xwoba": (0.35, False), "barrel_pct": (0.25, False), "hard_hit_pct": (0.20, False), "sweet_spot_pct": (0.10, False), "squared_up_pct": (0.10, False)},
    "plate_discipline": {"chase_pct": (0.35, True), "zone_contact_pct": (0.30, False), "whiff_pct": (0.20, True), "inside_swing_pct": (0.15, False)},
    "patience_score": {"bb_pct": (0.45, False), "first_pitch_swing_pct": (0.30, True), "swing_pct": (0.15, True), "ibb_rate": (0.10, False)},
    "speed_score": {"sb_attempt_rate": (0.35, False), "sb_success_rate": (0.25, False), "triples_rate": (0.25, False), "gidp_rate": (0.15, True)},
    "matchup_score_raw": {"split_obp": (0.40, False), "split_slg": (0.40, False), "split_avg": (0.20, False)},
    "pitch_quality": {"siera": (0.25, True), "xfip": (0.20, True), "pitcher_k_pct": (0.20, False), "pitcher_bb_pct": (0.15, True), "pitcher_hr9": (0.10, True), "barrel_allowed_pct": (0.10, True)},
    "bullpen_quality": {"bullpen_era": (0.25, True), "bullpen_fip": (0.25, True), "bullpen_k_pct": (0.20, False), "bullpen_bb_pct": (0.15, True), "bullpen_hr9": (0.15, True)},
    "environment_score": {"run_factor": (0.25, False), "hr_factor": (0.25, False), "temperature": (0.15, False), "wind_factor": (0.15, False), "field_factor": (0.10, False), "altitude": (0.10, False)},
    "lineup_protection": {"team_slg": (0.35, False), "team_obp": (0.25, False), "team_hr": (0.20, False), "order_position_factor": (0.20, False)},
    "run_environment": {"team_rpg": (0.30, False), "team_ops": (0.25, False), "park_run_factor": (0.20, False), "opp_pitching_weakness_z": (0.25, False)},
}


def _generic_score(player, league, key):
    return to_score(weighted_z(player, league, WEIGHTS[key]))


def contact_score(p, lg): return _generic_score(p, lg, "contact_score")
def power_score(p, lg): return _generic_score(p, lg, "power_score")
def quality_of_contact(p, lg): return _generic_score(p, lg, "quality_of_contact")
def plate_discipline(p, lg): return _generic_score(p, lg, "plate_discipline")
def patience_score(p, lg): return _generic_score(p, lg, "patience_score")
def speed_score(p, lg): return _generic_score(p, lg, "speed_score")
def pitch_quality(p, lg): return _generic_score(p, lg, "pitch_quality")
def bullpen_quality(p, lg): return _generic_score(p, lg, "bullpen_quality")
def environment_score(p, lg): return _generic_score(p, lg, "environment_score")
def lineup_protection(p, lg): return _generic_score(p, lg, "lineup_protection")
def run_environment(p, lg): return _generic_score(p, lg, "run_environment")


def matchup_score(p, lg, split_pa: int, k: float = 100) -> float:
    raw_z = weighted_z(p, lg, WEIGHTS["matchup_score_raw"])
    return to_score(shrink(raw_z, 0.0, split_pa, k))


def historical_matchup(bvp_ops, bvp_pa, matchup_score_baseline, k: float = 20) -> float:
    bvp_z = (bvp_ops - 0.720) / 0.130 if bvp_ops is not None else 0.0
    return to_score(shrink(bvp_z, zscore_to_score_inverse(matchup_score_baseline), bvp_pa, k))


def recent_form(recent_woba_7, recent_woba_15, recent_woba_30, recent_pa_15, season_woba, lg_woba_mean, lg_woba_std, k: float = 50) -> float:
    blend = 0.5 * recent_woba_7 + 0.3 * recent_woba_15 + 0.2 * recent_woba_30
    return to_score((shrink(blend, season_woba, recent_pa_15, k) - lg_woba_mean) / lg_woba_std)


SLOT_BASE_PA = {1: 4.65, 2: 4.55, 3: 4.45, 4: 4.35, 5: 4.25, 6: 4.15, 7: 4.05, 8: 3.95, 9: 3.85}
ORDER_BONUS = {1: 0.0, 2: 0.5, 3: 1.0, 4: 1.0, 5: 0.5, 6: 0.0, 7: -0.5, 8: -1.0, 9: -1.0}


def expected_pa(batting_order, team_rpg, league_rpg, park_run_factor, is_home):
    base = SLOT_BASE_PA.get(batting_order, 4.0)
    return base * (1 + 0.15 * ((team_rpg / league_rpg) - 1)) * (1 + 0.05 * ((park_run_factor / 100) - 1)) * (1.0 if is_home else 0.99)


def opportunity_score(expected_pa_val, team_obp, batting_order, is_home, lg_pa_mean=4.10, lg_pa_std=0.30, lg_obp_mean=0.320, lg_obp_std=0.030):
    composite_z = 0.30 * ((expected_pa_val - lg_pa_mean) / lg_pa_std) + 0.35 * ((team_obp - lg_obp_mean) / lg_obp_std) + 0.20 * ORDER_BONUS.get(batting_order, 0.0) + 0.15 * (0.3 if is_home else 0.0)
    return to_score(composite_z)


def fatigue_adjustment(is_doubleheader_g2, day_after_night, travel_distance, off_day_before, age):
    score = 50.0
    if is_doubleheader_g2: score -= 8
    if day_after_night: score -= 5
    if travel_distance and travel_distance > 1500 and not off_day_before: score -= 5
    if off_day_before: score += 5
    if age and age >= 33: score -= min(5, age - 32)
    return float(np.clip(score, 0, 100))


def bullpen_adjustment(p, lg, starter_avg_ip):
    bq_score = bullpen_quality(p, lg)
    exposure = float(np.clip((9 - starter_avg_ip) / 9, 0.2, 0.8))
    return 50 + (bq_score - 50) * exposure * 1.5


def build_run_environment_input(p, lg):
    out = dict(p)
    out["opp_pitching_weakness_z"] = -0.5 * zscore_to_score_inverse(pitch_quality(p, lg)) - 0.5 * zscore_to_score_inverse(bullpen_quality(p, lg))
    return out


_EXTERNAL_FACTOR_KEYS = {"pitch_quality", "bullpen_quality", "environment_score", "lineup_protection", "run_environment"}


def _baseline_columns(frame: pd.DataFrame) -> list[str]:
    return sorted({col for weights in WEIGHTS.values() for col in weights if col in frame.columns})


def build_derived_features(df: pd.DataFrame, league: dict | None = None) -> pd.DataFrame:
    """Compute factor columns from aggregator output, preserving missing inputs."""
    if not isinstance(df, pd.DataFrame):
        raise TypeError("Expected pandas.DataFrame")
    league = league or compute_league_baseline(df, _baseline_columns(df))
    rows = []
    for _, record in df.iterrows():
        p = record.to_dict()
        row = dict(p)
        row.update({
            "ContactScore": contact_score(p, league), "PowerScore": power_score(p, league),
            "QualityOfContact": quality_of_contact(p, league), "PlateDiscipline": plate_discipline(p, league),
            "PatienceScore": patience_score(p, league), "SpeedScore": speed_score(p, league),
        })
        row["MatchupScore"] = matchup_score(p, league, int(p.get("split_pa", 0) or 0))
        run_environment_input = build_run_environment_input(p, league)
        for name, fn in (("PitchQuality", pitch_quality), ("BullpenQuality", bullpen_quality), ("EnvironmentScore", environment_score), ("LineupProtection", lineup_protection), ("RunEnvironment", run_environment)):
            required = WEIGHTS[{"PitchQuality":"pitch_quality", "BullpenQuality":"bullpen_quality", "EnvironmentScore":"environment_score", "LineupProtection":"lineup_protection", "RunEnvironment":"run_environment"}[name]]
            factor_input = run_environment_input if name == "RunEnvironment" else p
            row[name] = np.nan if not all(col in factor_input and pd.notna(factor_input[col]) for col in required) else fn(factor_input, league)
        row["BullpenAdjustment"] = np.nan if pd.isna(row["BullpenQuality"]) or pd.isna(p.get("starter_avg_ip")) else bullpen_adjustment(p, league, p["starter_avg_ip"])
        row["HistoricalMatchup"] = historical_matchup(p["bvp_ops"], p["bvp_pa"], row["MatchupScore"]) if pd.notna(p.get("bvp_ops")) and pd.notna(p.get("bvp_pa")) else np.nan
        row["RecentForm"] = recent_form(p["recent_woba_7"], p["recent_woba_15"], p["recent_woba_30"], p["recent_pa_15"], p["season_woba"], p["lg_woba_mean"], p["lg_woba_std"]) if all(pd.notna(p.get(k)) for k in ("recent_woba_7", "recent_woba_15", "recent_woba_30", "recent_pa_15", "season_woba", "lg_woba_mean", "lg_woba_std")) else np.nan
        row["ExpectedPA"] = expected_pa(p["batting_order"], p["team_rpg"], p["league_rpg"], p["park_run_factor"], p["is_home"]) if all(pd.notna(p.get(k)) for k in ("batting_order", "team_rpg", "league_rpg", "park_run_factor", "is_home")) else np.nan
        row["OpportunityScore"] = opportunity_score(row["ExpectedPA"], p["team_obp"], p["batting_order"], p["is_home"]) if pd.notna(row["ExpectedPA"]) and all(pd.notna(p.get(k)) for k in ("team_obp", "batting_order", "is_home")) else np.nan
        row["FatigueAdjustment"] = fatigue_adjustment(p["is_doubleheader_g2"], p["day_after_night"], p["travel_distance"], p["off_day_before"], p["age"]) if all(k in p and pd.notna(p[k]) for k in ("is_doubleheader_g2", "day_after_night", "travel_distance", "off_day_before", "age")) else np.nan
        rows.append(row)
    return pd.DataFrame(rows, index=df.index)


__all__ = ["WEIGHTS", "compute_league_baseline", "build_derived_features", "contact_score", "power_score", "quality_of_contact", "plate_discipline", "patience_score", "speed_score", "matchup_score", "historical_matchup", "recent_form", "expected_pa", "opportunity_score", "pitch_quality", "bullpen_quality", "bullpen_adjustment", "run_environment", "environment_score", "lineup_protection", "fatigue_adjustment"]
