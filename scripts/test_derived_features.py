"""Smoke test for the official Statcast Derived Feature framework."""

from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPOSITORY_ROOT))

from statcast.derived_features import build_derived_features  # noqa: E402
from statcast.raw_features import build_raw_features  # noqa: E402


INPUT_PATH = REPOSITORY_ROOT / "work/aaron-judge-2024-statcast.pkl"
OUTPUT_PATH = REPOSITORY_ROOT / "work/derived_features_sample.csv"


def main() -> None:
    events = pd.read_pickle(INPUT_PATH)
    raw_features = build_raw_features(events)
    derived_features = build_derived_features(raw_features)

    print("derived_feature_columns:")
    for column in derived_features.columns:
        print(f"  - {column}")
    print("first_five_rows:")
    print(derived_features.head(5).to_string(index=False))

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    derived_features.to_csv(OUTPUT_PATH, index=False)
    print(f"saved_derived_features: {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
