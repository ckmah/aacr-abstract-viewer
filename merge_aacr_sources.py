#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""
Merge poster abstracts (aacr_abstracts.json) with program-guide talks
(aacr_program_guide.json), normalize to the webapp schema, write app/public/aacr_data.json.

Expected poster rows: planner-style fields (e.g. id, title, abstract, authorBlock, sessionTitle,
presentationNumber, posterboardNumber, presenter, start). Obtain that file from the AACR online
itinerary / your export pipeline; this repo no longer ships an abstractsonline scraper.

Posters win on duplicate id. Run precompute_embeddings.py afterward.

Usage:
  uv run merge_aacr_sources.py
  uv run merge_aacr_sources.py --posters a.json --talks b.json --out app/public/aacr_data.json
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

from aacr_time_utils import harmonize_start


def authors_from_author_block(html: str | None) -> list[str]:
    if not html:
        return []
    return [x.strip() for x in re.findall(r"<b>([^<]+)</b>", html) if x.strip()]


def topics_from_raw(raw) -> list[str]:
    if isinstance(raw, list):
        return [str(t).strip() for t in raw if str(t).strip()]
    if not raw:
        return []
    parts = re.split(r",,+|\|\|", str(raw))
    out = []
    for p in parts:
        t = re.sub(r"^[+\s]+", "", p).strip()
        if t and len(t) > 1:
            out.append(t)
    return out[:24]


def normalize_poster(p: dict) -> dict:
    authors = authors_from_author_block(p.get("authorBlock"))
    pid = str(p.get("id", ""))
    poster_num = str(
        p.get("presentationNumber") or p.get("posterboardNumber") or p.get("controlNumber") or ""
    )
    return {
        "id": pid,
        "type": "poster",
        "title": (p.get("title") or "").strip(),
        "authors": authors,
        "institution": "",
        "session": (p.get("sessionTitle") or p.get("session") or "").strip(),
        "cancerType": "Pan-Cancer / Other",
        "topics": topics_from_raw(p.get("topics") or p.get("keywords")),
        "posterNumber": poster_num,
        "abstract": (p.get("abstract") or "").strip(),
        "presenter": (p.get("presenter") or "").strip(),
        "start": harmonize_start(p.get("start") or ""),
        "source": "abstractsonline_poster",
        "includeInSemanticMap": True,
    }


def normalize_talk(t: dict) -> dict:
    return {
        "id": str(t.get("id", "")),
        "type": "talk",
        "title": (t.get("title") or "").strip(),
        "authors": list(t.get("authors") or []),
        "institution": (t.get("institution") or "").strip(),
        "session": (t.get("session") or "").strip(),
        "cancerType": t.get("cancerType") or "Pan-Cancer / Other",
        "topics": list(t.get("topics") or []),
        "posterNumber": str(t.get("posterNumber") or ""),
        "abstract": (t.get("abstract") or "").strip(),
        "presenter": (t.get("presenter") or "").strip(),
        "start": harmonize_start(t.get("start") or ""),
        "source": t.get("source") or "program_guide_pdf",
        "location": (t.get("location") or "").strip(),
        "chair": (t.get("chair") or "").strip(),
        "includeInSemanticMap": bool(t.get("includeInSemanticMap", True)),
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--posters", type=Path, default=Path("aacr_abstracts.json"))
    ap.add_argument("--talks", type=Path, default=Path("aacr_program_guide.json"))
    ap.add_argument("--out", type=Path, default=Path("app/public/aacr_data.json"))
    args = ap.parse_args()

    if not args.posters.is_file():
        raise SystemExit(f"Missing posters file: {args.posters}")
    if not args.talks.is_file():
        raise SystemExit(f"Missing talks file: {args.talks}")

    posters_raw = json.loads(args.posters.read_text(encoding="utf-8"))
    talks_raw = json.loads(args.talks.read_text(encoding="utf-8"))

    posters = [normalize_poster(p) for p in posters_raw]
    poster_ids = {p["id"] for p in posters}
    talks = [normalize_talk(t) for t in talks_raw if str(t.get("id", "")) not in poster_ids]

    merged = posters + talks
    for i, a in enumerate(merged):
        a["internalId"] = i

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(merged, indent=2), encoding="utf-8")
    print(f"Wrote {args.out} — {len(posters)} posters + {len(talks)} talks = {len(merged)} total")


if __name__ == "__main__":
    main()
