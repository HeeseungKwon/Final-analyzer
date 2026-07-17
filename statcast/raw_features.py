"""Official raw Statcast feature selection and naming.

This module intentionally performs only column selection and renaming. It does
not calculate, aggregate, impute, or otherwise transform Statcast values.
"""

from __future__ import annotations

import pandas as pd


# Source pybaseball column -> stable camelCase Raw Feature name.
# The order is the order used in the returned DataFrame.
RAW_FEATURE_COLUMNS: dict[str, str] = {
    "game_date": "gameDate",
    "game_year": "gameYear",
    "game_pk": "gameId",
    "game_type": "gameType",
    "player_name": "batterName",
    "batter": "batterId",
    "pitcher": "pitcherId",
    "home_team": "homeTeam",
    "away_team": "awayTeam",
    "stand": "batterStance",
    "p_throws": "pitcherThrows",
    "pitch_type": "pitchType",
    "pitch_name": "pitchName",
    "description": "pitchDescription",
    "events": "plateAppearanceEvent",
    "type": "pitchResultType",
    "bb_type": "battedBallType",
    "hit_location": "hitLocationCode",
    "balls": "ballsBeforePitch",
    "strikes": "strikesBeforePitch",
    "zone": "strikeZoneLocation",
    "outs_when_up": "outsBeforePitch",
    "inning": "inningNumber",
    "inning_topbot": "inningHalf",
    "at_bat_number": "atBatNumber",
    "pitch_number": "pitchNumber",
    "on_1b": "runnerOnFirstId",
    "on_2b": "runnerOnSecondId",
    "on_3b": "runnerOnThirdId",
    "release_speed": "pitchVelocity",
    "effective_speed": "effectivePitchVelocity",
    "release_spin_rate": "spinRate",
    "spin_axis": "spinAxis",
    "release_extension": "releaseExtension",
    "release_pos_x": "releasePositionX",
    "release_pos_y": "releasePositionY",
    "release_pos_z": "releasePositionZ",
    "pfx_x": "pitchMovementX",
    "pfx_z": "pitchMovementZ",
    "plate_x": "plateLocationX",
    "plate_z": "plateLocationZ",
    "vx0": "pitchVelocityX0",
    "vy0": "pitchVelocityY0",
    "vz0": "pitchVelocityZ0",
    "ax": "pitchAccelerationX",
    "ay": "pitchAccelerationY",
    "az": "pitchAccelerationZ",
    "api_break_z_with_gravity": "pitchBreakZWithGravity",
    "api_break_x_arm": "pitchBreakXArmSide",
    "api_break_x_batter_in": "pitchBreakXBatterIn",
    "arm_angle": "armAngle",
    "sz_top": "strikeZoneTop",
    "sz_bot": "strikeZoneBottom",
    "launch_speed": "exitVelocity",
    "launch_angle": "launchAngle",
    "hit_distance_sc": "hitDistance",
    "hc_x": "hitCoordinateX",
    "hc_y": "hitCoordinateY",
    "estimated_ba_using_speedangle": "xBA",
    "estimated_slg_using_speedangle": "xSLG",
    "estimated_woba_using_speedangle": "xwOBA",
    "woba_value": "wobaValue",
    "woba_denom": "wobaDenominator",
    "babip_value": "babipValue",
    "iso_value": "isoValue",
    "launch_speed_angle": "launchSpeedAngleCode",
    "bat_speed": "batSpeed",
    "swing_length": "swingLength",
    "miss_distance": "missDistance",
    "attack_angle": "attackAngle",
    "attack_direction": "attackDirection",
    "swing_path_tilt": "swingPathTilt",
    "intercept_ball_minus_batter_pos_x_inches": "interceptBallMinusBatterPositionX",
    "intercept_ball_minus_batter_pos_y_inches": "interceptBallMinusBatterPositionY",
    "hyper_speed": "hyperSpeed",
    "if_fielding_alignment": "infieldAlignment",
    "of_fielding_alignment": "outfieldAlignment",
    "home_score": "homeScoreBeforePitch",
    "away_score": "awayScoreBeforePitch",
    "bat_score": "battingTeamScoreBeforePitch",
    "fld_score": "fieldingTeamScoreBeforePitch",
    "post_home_score": "homeScoreAfterPitch",
    "post_away_score": "awayScoreAfterPitch",
    "post_bat_score": "battingTeamScoreAfterPitch",
    "post_fld_score": "fieldingTeamScoreAfterPitch",
    "home_score_diff": "homeScoreDifferential",
    "bat_score_diff": "battingTeamScoreDifferential",
    "home_win_exp": "homeWinExpectancy",
    "bat_win_exp": "battingTeamWinExpectancy",
    "delta_home_win_exp": "homeWinExpectancyDelta",
    "delta_run_exp": "runExpectancyDelta",
    "delta_pitcher_run_exp": "pitcherRunExpectancyDelta",
    "age_pit": "pitcherAge",
    "age_bat": "batterAge",
    "n_thruorder_pitcher": "pitcherTimesThroughOrder",
    "n_priorpa_thisgame_player_at_bat": "batterPriorPlateAppearancesThisGame",
    "pitcher_days_since_prev_game": "pitcherDaysSincePreviousGame",
    "batter_days_since_prev_game": "batterDaysSincePreviousGame",
    "pitcher_days_until_next_game": "pitcherDaysUntilNextGame",
    "batter_days_until_next_game": "batterDaysUntilNextGame",
}


def build_raw_features(df: pd.DataFrame) -> pd.DataFrame:
    """Return selected pybaseball columns under standardized camelCase names.

    Missing source columns are omitted so this remains compatible with
    pybaseball schema revisions. Existing values and dtypes are left intact.
    """

    if not isinstance(df, pd.DataFrame):
        raise TypeError(f"Expected pandas.DataFrame, got {type(df)!r}")

    source_columns = [column for column in RAW_FEATURE_COLUMNS if column in df.columns]
    return df.loc[:, source_columns].rename(columns=RAW_FEATURE_COLUMNS).copy()
