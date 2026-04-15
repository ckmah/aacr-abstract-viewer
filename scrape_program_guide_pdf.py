#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "pypdf",
# ]
# ///
"""
Extract invited-session schedule entries from AACR2026_Program_Guide.pdf.

The PDF lists dates, times, locations, session titles, chairs/moderators, and
invited presentation titles (sometimes with abstract-style IDs such as PL03-03).
It does not include minisymposium or poster abstract bodies (per AACR; those are
online-only).

Output: aacr_program_guide.json — array of records shaped like aacr abstracts (title,
session, start, presenter, id when present) for use with precompute_embeddings.py or
merged with a planner export (aacr_abstracts.json).

Usage:
  uv run scrape_program_guide_pdf.py
  uv run scrape_program_guide_pdf.py --pdf other.pdf --out out.json
"""

from __future__ import annotations

import argparse
import json
import re
from dataclasses import dataclass, field
from pathlib import Path

from pypdf import PdfReader

from aacr_time_utils import harmonize_start

YEAR = 2026
MONTH_MAP = {
    "JANUARY": 1,
    "FEBRUARY": 2,
    "MARCH": 3,
    "APRIL": 4,
    "MAY": 5,
    "JUNE": 6,
    "JULY": 7,
    "AUGUST": 8,
    "SEPTEMBER": 9,
    "OCTOBER": 10,
    "NOVEMBER": 11,
    "DECEMBER": 12,
}

PAGE_HEADER_RE = re.compile(
    r"^\d+\s+AACR ANNUAL MEETING \d{4} PROGRAM GUIDE\s*$", re.I
)
DAY_LINE_RE = re.compile(
    r"^(MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY|SATURDAY|SUNDAY),\s+"
    r"(JANUARY|FEBRUARY|MARCH|APRIL|MAY|JUNE|JULY|AUGUST|SEPTEMBER|OCTOBER|NOVEMBER|DECEMBER)\s+"
    r"(\d{1,2})(?:\s*\|.*)?$",
    re.I,
)
ROOM_LINE_RE = re.compile(
    r"^(?:Room \d+|Ballroom [\d A-Z]+|Hall [A-Z](?: [A-Z])?|Grand Hall [A-Z])"
    r"\s*(?:-\s*|\|\s*).+$",
    re.I,
)
CHAIR_RE = re.compile(
    r"^(Chair|Co-?chairs?|Moderator):\s*(.+)$",
    re.I,
)
SESSION_TYPE_RE = re.compile(
    r"^(Plenary Session|Educational Sessions?|Special Session|Major Symposium|"
    r"Clinical Trials Plenary Session|Meet and Greet|Science Education|"
    r"Regulatory Science and Policy Session|Award Lecture|Presidential Address|"
    r"Professional Development Session)\s*$",
    re.I,
)
TIME_ITEM_RE = re.compile(
    r"^(\d{1,2}:\d{2}\s+(?:a\.m\.|p\.m\.))\s+(.+)$",
    re.I,
)
ABSTRACT_ID_RE = re.compile(
    r"^([A-Z]{1,6}\d{1,3}-\d{1,4})\s+(.+)$",
)

# Titles that are agenda logistics (chair intros, breaks, generic discussions) — keep in
# JSON for the table view but omit from the semantic map / embedding (see precompute).
_AGENDA_TITLE_PHRASES = (
    "chair introduction",
    "co-chair introduction",
    "introductory remarks",
    "opening remarks",
    "closing remarks",
    "welcome remarks",
    "welcome and",
    "panel discussion",
    "general discussion",
    "moderated discussion",
    "audience discussion",
    "expert panel",
    "roundtable discussion",
    "roundtable",
    "q&a",
    "q & a",
    "question and answer",
    "questions and answers",
    "networking break",
    "coffee break",
    "meet the professor",
    "meet-the-professor",
    "meet the expert",
    "meet and greet",
    "meet-the-experts",
    "lunch break",
    "poster discussion",
)
_AGENDA_TITLE_EXACT = frozenset(
    {
        "discussion",
        "introduction",
        "break",
        "panel",
        "remarks",
        "intermission",
        "q&a",
    }
)
_SHORT_EMBED_BODY = 120
_MIN_COMBINED_LEN = 40


def include_in_semantic_map(title: str, abstract: str, has_formal_id: bool) -> bool:
    """False for chair intros, generic discussions, etc., especially when description is short."""
    t = (title or "").strip()
    tl = t.lower()
    body = (abstract or "").strip()
    combined = f"{t} {body}".strip()

    if len(combined) < _MIN_COMBINED_LEN:
        return False

    for phrase in _AGENDA_TITLE_PHRASES:
        if phrase in tl:
            return False

    if tl in _AGENDA_TITLE_EXACT:
        return False

    if has_formal_id:
        return True

    if len(body) < _SHORT_EMBED_BODY:
        if re.search(
            r"\b(discussion|panel|introduction|remarks|moderator|chair|welcome|break)\b",
            tl,
        ):
            return False

    return True
SESSION_BLOCK_TIME_RE = re.compile(
    r"^\d{1,2}:\d{2}\s+(?:a\.m\.|p\.m\.)\s*[–-]\s*\d{1,2}:\d{2}\s+(?:a\.m\.|p\.m\.)",
    re.I,
)


def iso_date(day_name: str, month_name: str, day_num: int) -> str:
    m = MONTH_MAP[month_name.upper()]
    return f"{YEAR}-{m:02d}-{int(day_num):02d}"


def normalize_pdf_text(s: str) -> str:
    return (
        s.replace("\ufb01", "fi")
        .replace("\ufb02", "fl")
        .replace("›", ">")
        .replace("\u2013", "-")
        .replace("\u2014", "-")
    )


def extract_lines(reader: PdfReader) -> list[tuple[int, str]]:
    out: list[tuple[int, str]] = []
    for i, page in enumerate(reader.pages):
        raw = page.extract_text() or ""
        text = normalize_pdf_text(raw)
        for line in text.splitlines():
            line = line.rstrip()
            if not line.strip():
                continue
            if PAGE_HEADER_RE.match(line.strip()):
                continue
            out.append((i + 1, line))
    return out


@dataclass
class Context:
    day_iso: str | None = None
    session_location: str = ""
    session_title: str = ""
    session_track: str = ""
    chair: str = ""
    pending_title_lines: list[str] = field(default_factory=list)


def flush_pending_title(ctx: Context) -> None:
    if ctx.pending_title_lines:
        t = " ".join(x.strip() for x in ctx.pending_title_lines if x.strip())
        if t and not SESSION_TYPE_RE.match(t) and not SESSION_BLOCK_TIME_RE.match(t):
            if ctx.session_title:
                ctx.session_title = f"{ctx.session_title} {t}"
            else:
                ctx.session_title = t
        ctx.pending_title_lines.clear()


def parse_program_guide(lines: list[tuple[int, str]]) -> list[dict]:
    ctx = Context()
    records: list[dict] = []
    seq = 0

    def emit(
        page: int,
        time_s: str,
        body: str,
    ) -> None:
        nonlocal seq
        aid = ""
        rest = body.strip()
        m = ABSTRACT_ID_RE.match(rest)
        if m:
            aid, rest = m.group(1), m.group(2).strip()

        title_guess = rest
        presenter = ""
        if ". " in rest:
            left, right = rest.rsplit(". ", 1)
            if "," in right and re.search(r"[A-Za-z]", right):
                title_guess = left.strip()
                presenter = right.strip()

        start_raw = f"{ctx.day_iso or ''} {time_s}".strip() if ctx.day_iso else time_s
        start = harmonize_start(start_raw) or start_raw.strip()
        seq += 1
        pid = aid if aid else f"pg-{page}-{seq}"
        authors = [presenter] if presenter else []

        detail = rest[:4000]
        title_out = title_guess[:500] if title_guess else rest[:500]
        records.append(
            {
                "internalId": seq,
                "id": pid,
                "type": "talk",
                "title": title_out,
                "authors": authors,
                "institution": "",
                "session": ctx.session_title or ctx.session_track or "",
                "cancerType": "Pan-Cancer / Other",
                "topics": [],
                "posterNumber": aid if aid else "",
                "abstract": detail,
                "presenter": presenter,
                "start": start,
                "source": "program_guide_pdf",
                "location": ctx.session_location,
                "chair": ctx.chair,
                "programGuideDetail": detail,
                "includeInSemanticMap": include_in_semantic_map(
                    title_out, detail, bool(aid)
                ),
            }
        )

    i = 0
    while i < len(lines):
        page, line = lines[i]
        stripped = line.strip()

        dm = DAY_LINE_RE.match(stripped)
        if dm:
            flush_pending_title(ctx)
            ctx.day_iso = iso_date(dm.group(1), dm.group(2), int(dm.group(3)))
            ctx.session_location = ""
            ctx.session_title = ""
            ctx.session_track = ""
            ctx.chair = ""
            i += 1
            continue

        if SESSION_TYPE_RE.match(stripped):
            ctx.session_track = stripped
            i += 1
            continue

        if ROOM_LINE_RE.match(stripped):
            flush_pending_title(ctx)
            ctx.session_location = stripped
            ctx.session_title = ""
            ctx.chair = ""
            ctx.pending_title_lines = []
            i += 1
            j = i
            while j < len(lines):
                _, ln = lines[j]
                s2 = ln.strip()
                if (
                    DAY_LINE_RE.match(s2)
                    or ROOM_LINE_RE.match(s2)
                    or CHAIR_RE.match(s2)
                    or TIME_ITEM_RE.match(s2)
                    or SESSION_BLOCK_TIME_RE.match(s2)
                    or s2.startswith("Panelists:")
                ):
                    break
                if SESSION_TYPE_RE.match(s2):
                    ctx.session_track = s2
                    j += 1
                    continue
                if s2.upper().startswith("NOT ELIGIBLE FOR CME"):
                    j += 1
                    continue
                ctx.pending_title_lines.append(s2)
                j += 1
            flush_pending_title(ctx)
            i = j
            continue

        cm = CHAIR_RE.match(stripped)
        if cm:
            parts_chair = [cm.group(2).strip()]
            i += 1
            while i < len(lines):
                _, ln2 = lines[i]
                s2 = ln2.strip()
                if (
                    DAY_LINE_RE.match(s2)
                    or ROOM_LINE_RE.match(s2)
                    or CHAIR_RE.match(s2)
                    or TIME_ITEM_RE.match(s2)
                    or SESSION_BLOCK_TIME_RE.match(s2)
                    or SESSION_TYPE_RE.match(s2)
                ):
                    break
                parts_chair.append(s2)
                i += 1
            ctx.chair = " ".join(parts_chair)
            continue

        if SESSION_BLOCK_TIME_RE.match(stripped):
            i += 1
            continue

        tm = TIME_ITEM_RE.match(stripped)
        if tm:
            time_s, body = tm.group(1), tm.group(2)
            body = body.strip()
            k = i + 1
            while k < len(lines):
                _, ln2 = lines[k]
                s2 = ln2.strip()
                if TIME_ITEM_RE.match(s2) or ROOM_LINE_RE.match(s2) or DAY_LINE_RE.match(s2):
                    break
                if CHAIR_RE.match(s2):
                    break
                if SESSION_BLOCK_TIME_RE.match(s2):
                    break
                body = f"{body} {s2}"
                k += 1
            emit(page, time_s, body)
            i = k
            continue

        i += 1

    return records


def main() -> None:
    ap = argparse.ArgumentParser(description="Parse AACR Program Guide PDF to JSON.")
    ap.add_argument(
        "--pdf",
        type=Path,
        default=Path("AACR2026_Program_Guide.pdf"),
        help="Path to Program Guide PDF",
    )
    ap.add_argument(
        "--out",
        type=Path,
        default=Path("aacr_program_guide.json"),
        help="Output JSON path",
    )
    args = ap.parse_args()

    if not args.pdf.is_file():
        raise SystemExit(f"PDF not found: {args.pdf}")

    reader = PdfReader(str(args.pdf))
    lines = extract_lines(reader)
    records = parse_program_guide(lines)

    args.out.write_text(json.dumps(records, indent=2), encoding="utf-8")
    print(f"Wrote {len(records)} entries to {args.out}")
    with_id = sum(1 for r in records if re.match(r"^[A-Z]+\d", r["id"] or ""))
    print(f"  Entries with abstract-style IDs: {with_id}")


if __name__ == "__main__":
    main()
