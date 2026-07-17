"""Inventory the raw columns returned by pybaseball Statcast."""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any

import pandas as pd


DEFAULT_INPUT = Path("work/aaron-judge-2024-statcast.pkl")
DEFAULT_INVENTORY_OUTPUT = Path("work/statcast_column_inventory.csv")
DEFAULT_MAPPING_OUTPUT = Path("work/raw_feature_mapping.csv")


# These mappings are intentionally explicit. A column is only assigned a
# standardized name when its pybaseball/Statcast meaning is unambiguous.
# Unlisted and deprecated fields remain blank for manual review.
RAW_FEATURE_MAPPING: dict[str, dict[str, str]] = {
    "pitch_type": {"raw_feature": "pitch_type", "description": "MLB pitch type code."},
    "game_date": {"raw_feature": "game_date", "description": "Date of the game."},
    "release_speed": {"raw_feature": "pitch_release_speed_mph", "description": "Pitch release speed in miles per hour."},
    "release_pos_x": {"raw_feature": "pitch_release_position_x_ft", "description": "Pitch release position on the x axis, in feet."},
    "release_pos_z": {"raw_feature": "pitch_release_position_z_ft", "description": "Pitch release position on the z axis, in feet."},
    "player_name": {"raw_feature": "batter_name", "description": "Batter display name returned by Statcast."},
    "batter": {"raw_feature": "batter_id", "description": "MLB person ID for the batter."},
    "pitcher": {"raw_feature": "pitcher_id", "description": "MLB person ID for the pitcher."},
    "events": {"raw_feature": "plate_appearance_event", "description": "Statcast plate-appearance result label, when present."},
    "description": {"raw_feature": "pitch_description", "description": "Statcast pitch-level description."},
    "zone": {"raw_feature": "strike_zone_location", "description": "Statcast strike-zone location code."},
    "des": {"raw_feature": "play_description", "description": "Statcast play description text."},
    "game_type": {"raw_feature": "game_type", "description": "Game type code."},
    "stand": {"raw_feature": "batter_stance", "description": "Batter stance: left or right."},
    "p_throws": {"raw_feature": "pitcher_throws", "description": "Pitcher throwing hand: left or right."},
    "home_team": {"raw_feature": "home_team_id", "description": "Home team abbreviation."},
    "away_team": {"raw_feature": "away_team_id", "description": "Away team abbreviation."},
    "type": {"raw_feature": "pitch_result_type", "description": "Statcast pitch result type code."},
    "hit_location": {"raw_feature": "hit_location_code", "description": "Statcast defensive hit-location code, when present."},
    "bb_type": {"raw_feature": "batted_ball_type", "description": "Batted-ball type, when present."},
    "balls": {"raw_feature": "balls_before_pitch", "description": "Ball count before the pitch."},
    "strikes": {"raw_feature": "strikes_before_pitch", "description": "Strike count before the pitch."},
    "game_year": {"raw_feature": "game_year", "description": "Season/game year."},
    "pfx_x": {"raw_feature": "pitch_movement_x_in", "description": "Pitch horizontal movement in inches."},
    "pfx_z": {"raw_feature": "pitch_movement_z_in", "description": "Pitch vertical movement in inches."},
    "plate_x": {"raw_feature": "plate_location_x_ft", "description": "Pitch location crossing home plate on the x axis, in feet."},
    "plate_z": {"raw_feature": "plate_location_z_ft", "description": "Pitch location crossing home plate on the z axis, in feet."},
    "on_3b": {"raw_feature": "runner_on_third_id", "description": "MLB person ID of runner on third base, when present."},
    "on_2b": {"raw_feature": "runner_on_second_id", "description": "MLB person ID of runner on second base, when present."},
    "on_1b": {"raw_feature": "runner_on_first_id", "description": "MLB person ID of runner on first base, when present."},
    "outs_when_up": {"raw_feature": "outs_before_pitch", "description": "Number of outs before the pitch."},
    "inning": {"raw_feature": "inning_number", "description": "Inning number."},
    "inning_topbot": {"raw_feature": "inning_half", "description": "Top or bottom half of the inning."},
    "hc_x": {"raw_feature": "hit_coordinate_x", "description": "Statcast hit-location coordinate on the x axis, when present."},
    "hc_y": {"raw_feature": "hit_coordinate_y", "description": "Statcast hit-location coordinate on the y axis, when present."},
    "vx0": {"raw_feature": "pitch_velocity_x0", "description": "Initial pitch velocity component on the x axis."},
    "vy0": {"raw_feature": "pitch_velocity_y0", "description": "Initial pitch velocity component on the y axis."},
    "vz0": {"raw_feature": "pitch_velocity_z0", "description": "Initial pitch velocity component on the z axis."},
    "ax": {"raw_feature": "pitch_acceleration_x", "description": "Pitch acceleration component on the x axis."},
    "ay": {"raw_feature": "pitch_acceleration_y", "description": "Pitch acceleration component on the y axis."},
    "az": {"raw_feature": "pitch_acceleration_z", "description": "Pitch acceleration component on the z axis."},
    "sz_top": {"raw_feature": "strike_zone_top_ft", "description": "Top of the batter-specific strike zone, in feet."},
    "sz_bot": {"raw_feature": "strike_zone_bottom_ft", "description": "Bottom of the batter-specific strike zone, in feet."},
    "hit_distance_sc": {"raw_feature": "hit_distance_ft", "description": "Statcast estimated hit distance, in feet, when present."},
    "launch_speed": {"raw_feature": "exit_velocity_mph", "description": "Batted-ball launch speed in miles per hour, when present."},
    "launch_angle": {"raw_feature": "launch_angle_deg", "description": "Batted-ball launch angle in degrees, when present."},
    "effective_speed": {"raw_feature": "effective_pitch_speed_mph", "description": "Statcast effective pitch speed."},
    "release_spin_rate": {"raw_feature": "pitch_release_spin_rate_rpm", "description": "Pitch release spin rate in revolutions per minute."},
    "release_extension": {"raw_feature": "pitch_release_extension_ft", "description": "Pitch release extension in feet."},
    "game_pk": {"raw_feature": "game_id", "description": "MLB game identifier."},
    "release_pos_y": {"raw_feature": "pitch_release_position_y_ft", "description": "Pitch release position on the y axis, in feet."},
    "estimated_ba_using_speedangle": {"raw_feature": "estimated_batting_average", "description": "Statcast estimated batting average using launch speed and angle, when present."},
    "estimated_woba_using_speedangle": {"raw_feature": "estimated_woba", "description": "Statcast estimated wOBA using launch speed and angle, when present."},
    "woba_value": {"raw_feature": "woba_value", "description": "Statcast wOBA value assigned to the event, when present."},
    "woba_denom": {"raw_feature": "woba_denominator", "description": "Statcast wOBA denominator flag/value, when present."},
    "babip_value": {"raw_feature": "babip_value", "description": "Statcast BABIP value assigned to the event, when present."},
    "iso_value": {"raw_feature": "iso_value", "description": "Statcast ISO value assigned to the event, when present."},
    "launch_speed_angle": {"raw_feature": "launch_speed_angle_code", "description": "Statcast launch-speed/angle classification code, when present."},
    "at_bat_number": {"raw_feature": "at_bat_number", "description": "At-bat number within the game."},
    "pitch_number": {"raw_feature": "pitch_number", "description": "Pitch number within the plate appearance."},
    "pitch_name": {"raw_feature": "pitch_name", "description": "Human-readable pitch name."},
    "home_score": {"raw_feature": "home_score_before_pitch", "description": "Home-team score before the pitch."},
    "away_score": {"raw_feature": "away_score_before_pitch", "description": "Away-team score before the pitch."},
    "bat_score": {"raw_feature": "batting_team_score_before_pitch", "description": "Batting-team score before the pitch."},
    "fld_score": {"raw_feature": "fielding_team_score_before_pitch", "description": "Fielding-team score before the pitch."},
    "post_away_score": {"raw_feature": "away_score_after_pitch", "description": "Away-team score after the pitch."},
    "post_home_score": {"raw_feature": "home_score_after_pitch", "description": "Home-team score after the pitch."},
    "post_bat_score": {"raw_feature": "batting_team_score_after_pitch", "description": "Batting-team score after the pitch."},
    "post_fld_score": {"raw_feature": "fielding_team_score_after_pitch", "description": "Fielding-team score after the pitch."},
    "if_fielding_alignment": {"raw_feature": "infield_alignment", "description": "Infield defensive alignment label."},
    "of_fielding_alignment": {"raw_feature": "outfield_alignment", "description": "Outfield defensive alignment label."},
    "spin_axis": {"raw_feature": "pitch_spin_axis_deg", "description": "Pitch spin axis in degrees."},
    "delta_home_win_exp": {"raw_feature": "home_win_expectancy_delta", "description": "Statcast change in home-team win expectancy."},
    "delta_run_exp": {"raw_feature": "run_expectancy_delta", "description": "Statcast change in run expectancy."},
    "bat_speed": {"raw_feature": "bat_speed_mph", "description": "Bat speed in miles per hour, when present."},
    "swing_length": {"raw_feature": "swing_length_ft", "description": "Swing length in feet, when present."},
    "miss_distance": {"raw_feature": "miss_distance_in", "description": "Distance between bat and ball on a miss, in inches, when present."},
    "estimated_slg_using_speedangle": {"raw_feature": "estimated_slugging_percentage", "description": "Statcast estimated slugging using launch speed and angle, when present."},
    "delta_pitcher_run_exp": {"raw_feature": "pitcher_run_expectancy_delta", "description": "Statcast change in pitcher run expectancy."},
    "hyper_speed": {"raw_feature": "hyper_speed_mph", "description": "Statcast hyper-speed value, when present."},
    "home_score_diff": {"raw_feature": "home_score_differential_before_pitch", "description": "Home-team score differential before the pitch."},
    "bat_score_diff": {"raw_feature": "batting_team_score_differential_before_pitch", "description": "Batting-team score differential before the pitch."},
    "home_win_exp": {"raw_feature": "home_win_expectancy", "description": "Home-team win expectancy before the pitch."},
    "bat_win_exp": {"raw_feature": "batting_team_win_expectancy", "description": "Batting-team win expectancy before the pitch."},
    "age_pit_legacy": {"raw_feature": "pitcher_age_legacy", "description": "Pitcher age using the legacy age field."},
    "age_bat_legacy": {"raw_feature": "batter_age_legacy", "description": "Batter age using the legacy age field."},
    "age_pit": {"raw_feature": "pitcher_age", "description": "Pitcher age."},
    "age_bat": {"raw_feature": "batter_age", "description": "Batter age."},
    "n_thruorder_pitcher": {"raw_feature": "pitcher_times_through_order", "description": "Pitcher times-through-order indicator."},
    "n_priorpa_thisgame_player_at_bat": {"raw_feature": "batter_prior_plate_appearances_game", "description": "Prior plate appearances by this batter in the game."},
    "pitcher_days_since_prev_game": {"raw_feature": "pitcher_days_since_previous_game", "description": "Days since the pitcher's previous game."},
    "batter_days_since_prev_game": {"raw_feature": "batter_days_since_previous_game", "description": "Days since the batter's previous game."},
    "pitcher_days_until_next_game": {"raw_feature": "pitcher_days_until_next_game", "description": "Days until the pitcher's next game, when available."},
    "batter_days_until_next_game": {"raw_feature": "batter_days_until_next_game", "description": "Days until the batter's next game, when available."},
    "api_break_z_with_gravity": {"raw_feature": "pitch_break_z_with_gravity_in", "description": "API pitch vertical break with gravity, in inches."},
    "api_break_x_arm": {"raw_feature": "pitch_break_x_arm_side_in", "description": "API pitch horizontal break from the arm-side perspective, in inches."},
    "api_break_x_batter_in": {"raw_feature": "pitch_break_x_batter_perspective_in", "description": "API pitch horizontal break from the batter-in perspective, in inches."},
    "arm_angle": {"raw_feature": "pitcher_arm_angle_deg", "description": "Pitcher arm angle in degrees, when present."},
    "attack_angle": {"raw_feature": "attack_angle_deg", "description": "Bat attack angle in degrees, when present."},
    "attack_direction": {"raw_feature": "attack_direction_deg", "description": "Bat attack direction in degrees, when present."},
    "swing_path_tilt": {"raw_feature": "swing_path_tilt_deg", "description": "Swing path tilt in degrees, when present."},
    "intercept_ball_minus_batter_pos_x_inches": {"raw_feature": "ball_intercept_minus_batter_x_in", "description": "Ball intercept position relative to batter position on x axis, in inches."},
    "intercept_ball_minus_batter_pos_y_inches": {"raw_feature": "ball_intercept_minus_batter_y_in", "description": "Ball intercept position relative to batter position on y axis, in inches."},
}


PITCHER_MODEL_FEATURES = {
    "pitch_type", "release_speed", "release_pos_x", "release_pos_z", "p_throws",
    "pitcher", "pfx_x", "pfx_z", "plate_x", "plate_z", "effective_speed",
    "release_spin_rate", "release_extension", "vx0", "vy0", "vz0", "ax", "ay", "az",
    "spin_axis", "api_break_z_with_gravity", "api_break_x_arm", "api_break_x_batter_in",
    "arm_angle", "pitch_name", "pitch_number", "balls", "strikes", "zone",
}

HITTER_MODEL_FEATURES = {
    "batter", "events", "description", "stand", "hit_location", "bb_type", "balls", "strikes",
    "hc_x", "hc_y", "hit_distance_sc", "launch_speed", "launch_angle", "estimated_ba_using_speedangle",
    "estimated_woba_using_speedangle", "woba_value", "babip_value", "iso_value", "launch_speed_angle",
    "bat_speed", "swing_length", "miss_distance", "estimated_slg_using_speedangle", "hyper_speed",
    "attack_angle", "attack_direction", "swing_path_tilt", "intercept_ball_minus_batter_pos_x_inches",
    "intercept_ball_minus_batter_pos_y_inches",
}

METADATA_ONLY = {
    "spin_dir", "spin_rate_deprecated", "break_angle_deprecated", "break_length_deprecated",
    "tfs_deprecated", "tfs_zulu_deprecated", "umpire", "sv_id", "fielder_2", "fielder_3",
    "fielder_4", "fielder_5", "fielder_6", "fielder_7", "fielder_8", "fielder_9",
}


def example_value(series: pd.Series) -> Any:
    non_null = series.dropna()
    if non_null.empty:
        return ""
    value = non_null.iloc[0]
    if hasattr(value, "item"):
        try:
            value = value.item()
        except ValueError:
            pass
    return value


def mapping_row(column: str, value: Any) -> dict[str, str]:
    mapping = RAW_FEATURE_MAPPING.get(column, {})
    recommended = "Yes" if mapping else "No"
    return {
        "pybaseball_column": column,
        "example_value": "" if value is None else str(value),
        "suggested_standardized_raw_feature": mapping.get("raw_feature", ""),
        "description": mapping.get("description", "Manual review required; meaning was not assigned by this inventory script."),
        "recommended": recommended,
    }


def inspect_columns(frame: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    inventory_rows = []
    mapping_rows = []
    for column in frame.columns:
        series = frame[column]
        non_null = int(series.notna().sum())
        missing_pct = (1 - non_null / len(frame)) * 100 if len(frame) else 0.0
        value = example_value(series)
        inventory_rows.append({
            "column_name": column,
            "data_type": str(series.dtype),
            "non_null_count": non_null,
            "missing_percentage": round(missing_pct, 4),
            "example_non_null_value": "" if value is None else str(value),
        })
        mapping_rows.append(mapping_row(column, value))
    return pd.DataFrame(inventory_rows), pd.DataFrame(mapping_rows)


def print_summary(frame: pd.DataFrame, mapping: pd.DataFrame) -> None:
    useful_hitter = [c for c in frame.columns if c in HITTER_MODEL_FEATURES and c in RAW_FEATURE_MAPPING]
    useful_pitcher = [c for c in frame.columns if c in PITCHER_MODEL_FEATURES and c in RAW_FEATURE_MAPPING]
    metadata = [c for c in frame.columns if c in METADATA_ONLY]
    print(f"total columns: {len(frame.columns)}")
    print(f"columns with data: {int(frame.notna().any(axis=0).sum())}")
    print(f"columns useful for hitter modeling: {len(useful_hitter)}")
    print("  " + ", ".join(useful_hitter))
    print(f"columns useful for pitcher modeling: {len(useful_pitcher)}")
    print("  " + ", ".join(useful_pitcher))
    print(f"columns that appear to be metadata only: {len(metadata)}")
    print("  " + ", ".join(metadata))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=DEFAULT_INPUT)
    parser.add_argument("--inventory-output", type=Path, default=DEFAULT_INVENTORY_OUTPUT)
    parser.add_argument("--mapping-output", type=Path, default=DEFAULT_MAPPING_OUTPUT)
    args = parser.parse_args()

    frame = pd.read_pickle(args.input)
    if not isinstance(frame, pd.DataFrame):
        raise TypeError(f"Expected pandas.DataFrame in {args.input}, got {type(frame)!r}")
    inventory, mapping = inspect_columns(frame)
    args.inventory_output.parent.mkdir(parents=True, exist_ok=True)
    args.mapping_output.parent.mkdir(parents=True, exist_ok=True)
    inventory.to_csv(args.inventory_output, index=False)
    mapping.to_csv(args.mapping_output, index=False)
    print_summary(frame, mapping)
    print(f"inventory report: {args.inventory_output}")
    print(f"raw feature mapping report: {args.mapping_output}")


if __name__ == "__main__":
    main()
