"""Standalone Statcast ingestion utilities.

This package is intentionally not imported by the MLB analyzer yet.
"""

__all__ = ["fetch_hitter_statcast_events", "save_raw_events"]


def __getattr__(name):
    if name in __all__:
        from .pybaseball_source import fetch_hitter_statcast_events, save_raw_events

        return {
            "fetch_hitter_statcast_events": fetch_hitter_statcast_events,
            "save_raw_events": save_raw_events,
        }[name]
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
