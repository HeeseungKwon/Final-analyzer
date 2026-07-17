"""Raw Statcast event ingestion through pybaseball.

The returned DataFrame is the object produced by ``pybaseball.statcast_batter``.
No feature engineering, filtering, coercion, or scoring is performed here.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pandas as pd
from pybaseball import statcast_batter


def fetch_hitter_statcast_events(
    player_id: int,
    start_date: str,
    end_date: str,
) -> pd.DataFrame:
    """Fetch raw event-level Statcast data for one hitter and date range.

    Dates use ``YYYY-MM-DD`` and are passed unchanged to pybaseball. The
    DataFrame returned by pybaseball is returned without selecting columns or
    transforming values, making it suitable for later derived-feature work.
    """

    events = statcast_batter(start_date, end_date, int(player_id))
    if events is None:
        return pd.DataFrame()
    if not isinstance(events, pd.DataFrame):
        raise TypeError(f"Expected pandas.DataFrame from pybaseball, got {type(events)!r}")
    return events


def save_raw_events(events: pd.DataFrame, output_path: str | Path) -> Path:
    """Persist the raw DataFrame without lossy column/value conversion."""

    if not isinstance(events, pd.DataFrame):
        raise TypeError(f"Expected pandas.DataFrame, got {type(events)!r}")
    path = Path(output_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    events.to_pickle(path)
    return path
