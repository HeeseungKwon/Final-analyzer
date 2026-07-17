"""Official Statcast Derived Feature framework.

This module consumes the standardized Raw Feature DataFrame produced by
statcast.raw_features.build_raw_features(). It intentionally does not calculate
weights, rates, aggregates, or model-ready scores yet.
"""

from __future__ import annotations

import numpy as np
import pandas as pd


DERIVED_FEATURE_COLUMNS = [
    "ContactScore",
    "PowerScore",
    "QualityOfContact",
    "PlateDiscipline",
    "PatienceScore",
    "SpeedScore",
]


CONTACT_SCORE_RAW_FEATURES = [
    "pitchDescription",
    "pitchResultType",
    "plateAppearanceEvent",
    "batSpeed",
    "swingLength",
    "missDistance",
    "plateLocationX",
    "plateLocationZ",
    "strikeZoneTop",
    "strikeZoneBottom",
]

POWER_SCORE_RAW_FEATURES = [
    "exitVelocity",
    "launchAngle",
    "hitDistance",
    "xSLG",
    "xwOBA",
    "launchSpeedAngleCode",
    "batSpeed",
    "hyperSpeed",
]

QUALITY_OF_CONTACT_RAW_FEATURES = [
    "exitVelocity",
    "launchAngle",
    "xBA",
    "xSLG",
    "xwOBA",
    "battedBallType",
    "launchSpeedAngleCode",
]

PLATE_DISCIPLINE_RAW_FEATURES = [
    "pitchDescription",
    "pitchResultType",
    "plateAppearanceEvent",
    "ballsBeforePitch",
    "strikesBeforePitch",
    "strikeZoneLocation",
    "plateLocationX",
    "plateLocationZ",
    "strikeZoneTop",
    "strikeZoneBottom",
]

PATIENCE_SCORE_RAW_FEATURES = [
    "pitchDescription",
    "pitchResultType",
    "ballsBeforePitch",
    "strikesBeforePitch",
    "pitchNumber",
    "atBatNumber",
    "batterPriorPlateAppearancesThisGame",
]

SPEED_SCORE_RAW_FEATURES = [
    "plateAppearanceEvent",
    "battedBallType",
    "hitLocationCode",
    "hitDistance",
    "runnerOnFirstId",
    "runnerOnSecondId",
    "runnerOnThirdId",
    "batterAge",
]


def _validate_raw_feature_frame(df: pd.DataFrame) -> None:
    if not isinstance(df, pd.DataFrame):
        raise TypeError(f"Expected pandas.DataFrame, got {type(df)!r}")


def _available_raw_features(df: pd.DataFrame, required_features: list[str]) -> pd.DataFrame:
    """Gather the Raw Feature inputs that exist without filling missing data."""

    existing_features = [feature for feature in required_features if feature in df.columns]
    return df.loc[:, existing_features].copy()


def _placeholder_feature(
    df: pd.DataFrame,
    output_name: str,
    required_features: list[str],
) -> pd.Series:
    _validate_raw_feature_frame(df)
    _available_raw_features(df, required_features)
    return pd.Series(np.nan, index=df.index, name=output_name, dtype="float64")


def build_contact_score(df: pd.DataFrame) -> pd.Series:
    """Build ContactScore placeholder.

    Expected Raw Features:
    pitchDescription, pitchResultType, plateAppearanceEvent, batSpeed,
    swingLength, missDistance, plateLocationX, plateLocationZ, strikeZoneTop,
    strikeZoneBottom.
    """

    return _placeholder_feature(df, "ContactScore", CONTACT_SCORE_RAW_FEATURES)


def build_power_score(df: pd.DataFrame) -> pd.Series:
    """Build PowerScore placeholder.

    Expected Raw Features:
    exitVelocity, launchAngle, hitDistance, xSLG, xwOBA,
    launchSpeedAngleCode, batSpeed, hyperSpeed.
    """

    return _placeholder_feature(df, "PowerScore", POWER_SCORE_RAW_FEATURES)


def build_quality_of_contact(df: pd.DataFrame) -> pd.Series:
    """Build QualityOfContact placeholder.

    Expected Raw Features:
    exitVelocity, launchAngle, xBA, xSLG, xwOBA, battedBallType,
    launchSpeedAngleCode.
    """

    return _placeholder_feature(
        df,
        "QualityOfContact",
        QUALITY_OF_CONTACT_RAW_FEATURES,
    )


def build_plate_discipline(df: pd.DataFrame) -> pd.Series:
    """Build PlateDiscipline placeholder.

    Expected Raw Features:
    pitchDescription, pitchResultType, plateAppearanceEvent, ballsBeforePitch,
    strikesBeforePitch, strikeZoneLocation, plateLocationX, plateLocationZ,
    strikeZoneTop, strikeZoneBottom.
    """

    return _placeholder_feature(df, "PlateDiscipline", PLATE_DISCIPLINE_RAW_FEATURES)


def build_patience_score(df: pd.DataFrame) -> pd.Series:
    """Build PatienceScore placeholder.

    Expected Raw Features:
    pitchDescription, pitchResultType, ballsBeforePitch, strikesBeforePitch,
    pitchNumber, atBatNumber, batterPriorPlateAppearancesThisGame.
    """

    return _placeholder_feature(df, "PatienceScore", PATIENCE_SCORE_RAW_FEATURES)


def build_speed_score(df: pd.DataFrame) -> pd.Series:
    """Build SpeedScore placeholder.

    Expected Raw Features:
    plateAppearanceEvent, battedBallType, hitLocationCode, hitDistance,
    runnerOnFirstId, runnerOnSecondId, runnerOnThirdId, batterAge.
    """

    return _placeholder_feature(df, "SpeedScore", SPEED_SCORE_RAW_FEATURES)


def build_derived_features(df: pd.DataFrame) -> pd.DataFrame:
    """Return the official Derived Feature placeholder DataFrame."""

    _validate_raw_feature_frame(df)
    return pd.DataFrame(
        {
            "ContactScore": build_contact_score(df),
            "PowerScore": build_power_score(df),
            "QualityOfContact": build_quality_of_contact(df),
            "PlateDiscipline": build_plate_discipline(df),
            "PatienceScore": build_patience_score(df),
            "SpeedScore": build_speed_score(df),
        },
        index=df.index,
        columns=DERIVED_FEATURE_COLUMNS,
    )
