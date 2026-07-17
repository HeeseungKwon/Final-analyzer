"""Smoke test: inspect one season of Aaron Judge Statcast event data."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

# Allow both ``python scripts/test_pybaseball_statcast.py`` and
# ``python -m scripts.test_pybaseball_statcast`` from the repository root.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from statcast.pybaseball_source import fetch_hitter_statcast_events, save_raw_events


AARON_JUDGE_ID = 592450


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--season", default="2024", help="Season year to inspect (default: 2024)")
    parser.add_argument("--output", type=Path, default=None, help="Optional pickle output path")
    args = parser.parse_args()

    start_date = f"{args.season}-03-01"
    end_date = f"{args.season}-11-30"
    events = fetch_hitter_statcast_events(AARON_JUDGE_ID, start_date, end_date)

    print(f"player_id: {AARON_JUDGE_ID}")
    print(f"date_range: {start_date} to {end_date}")
    print(f"row_count: {len(events)}")
    print("columns:")
    for column in events.columns:
        print(f"  - {column}")
    print("sample_records:")
    print(events.head(5).to_json(orient="records", date_format="iso", indent=2))

    if args.output is not None:
        output_path = save_raw_events(events, args.output)
        print(f"saved_raw_events: {output_path}")


if __name__ == "__main__":
    main()
