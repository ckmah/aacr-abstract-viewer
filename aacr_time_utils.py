"""Normalize poster vs program-guide time strings to one canonical form."""

from __future__ import annotations

import re
from datetime import datetime

def _normalize_ampm(s: str) -> str:
    s = s.strip()
    s = re.sub(r"(?i)\s*a\.m\.\s*$", " AM", s)
    s = re.sub(r"(?i)\s*p\.m\.\s*$", " PM", s)
    return s


def parse_start_datetime(s: str) -> datetime | None:
    """Parse planner / PDF / ISO-ish strings; return None if unknown."""
    if not s or not str(s).strip():
        return None
    u = _normalize_ampm(str(s).strip())
    fmts = (
        "%Y-%m-%d %I:%M:%S %p",
        "%Y-%m-%d %I:%M %p",
        "%m/%d/%Y %I:%M:%S %p",
        "%m/%d/%Y %I:%M %p",
        "%d/%m/%Y %I:%M:%S %p",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%dT%H:%M:%S.%f",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d %H:%M",
    )
    for fmt in fmts:
        try:
            return datetime.strptime(u, fmt)
        except ValueError:
            continue
    return None


def harmonize_start(s: str | None) -> str:
    """
    Canonical storage/display token: YYYY-MM-DD HH:MM (24h, local calendar fields).
    Falls back to stripped original if parsing fails.
    """
    if s is None:
        return ""
    raw = str(s).strip()
    if not raw:
        return ""
    dt = parse_start_datetime(raw)
    if dt is None:
        return raw
    # ISO 8601 local wall time (no Z) — parses reliably in JS Date
    return dt.strftime("%Y-%m-%dT%H:%M:00")
