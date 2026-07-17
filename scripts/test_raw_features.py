"""Smoke test for the official Statcast Raw Feature layer."""

from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPOSITORY_ROOT))

from statcast.raw_features import build_raw_features  # noqa: E402


INPUT_PATH = REPOSITORY_ROOT / "work/aaron-judge-2024-statcast.pkl"
OUTPUT_PATH = REPOSITORY_ROOT / "work/raw_features_sample.csv"


def main() -> None:
    events = pd.read_pickle(INPUT_PATH)
    raw_features = build_raw_features(events)

    print("raw_feature_columns:")
    for column in raw_features.columns:
        print(f"  - {column}")
    print("first_five_rows:")
    print(raw_features.head(5).to_string(index=False))

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    raw_features.to_csv(OUTPUT_PATH, index=False)
    print(f"saved_raw_features: {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
