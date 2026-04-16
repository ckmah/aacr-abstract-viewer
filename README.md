# AACR 2026 Abstract Explorer

An interactive browser for **poster abstracts** (from the AACR online planner, as `aacr_abstracts.json`) plus **invited talks** parsed from the official **Program Guide PDF** — merged into one semantic map for the [AACR Annual Meeting 2026](https://www.aacr.org/meeting/aacr-annual-meeting-2026/). You can pan, zoom, search, and filter **Posters / Talks / All**.

**Live app:** https://ckmah.github.io/aacr-abstract-viewer/

---

## Data source

- **Posters:** Full poster records (title, authors, abstract text, session, poster number, etc.) come from [abstractsonline.com](https://www.abstractsonline.com). Place the export as **`aacr_abstracts.json`** in the repo root (see `merge_aacr_sources.py` for the field names it reads).
- **Invited talks:** Dates, rooms, session titles, chairs, and invited presentation titles are extracted from the printed **Program Guide PDF** via `scrape_program_guide_pdf.py` (not individual poster rows; those stay online-only per AACR).

---

## Embedding pipeline

```
Posters: aacr_abstracts.json  (your planner export)
Talks:   AACR Program Guide PDF --> aacr_program_guide.json (scrape_program_guide_pdf.py)
           |
           v merge_aacr_sources.py (uv run)
    -------------------------------------------------
    Normalizes fields; posters win on duplicate id.
    Writes app/public/aacr_data.json (before embeddings)
           |
           v
  precompute_embeddings.py (uv run)
  ─────────────────────────────────────────────────────────────────────
  │  SentenceTransformer(all-MiniLM-L6-v2), UMAP 3D, KMeans + topics │
  └────────────────────────────────────────────────────────────────────
           |
           v
   app/public/aacr_data.json
   (posters + program-guide talks; x, y, z, cluster, clusterTopic)
           |
           v
   React + Canvas app  -->  GitHub Pages build (app/dist)
```

Similar research clusters together on the map; distant points are less semantically related.

---

## Interactive features

| Feature | How to use |
|---|---|
| **Pan** | Click and drag the canvas |
| **Zoom** | Scroll wheel — zooms anchored to cursor position |
| **Hover** | Hover a point to see title, authors, and session in a tooltip |
| **Select** | Click a point to open the detail panel |
| **Posters / Talks / All** | Filter by contribution type in the header |
| **Semantic search** | Search box colors points by similarity to your query |
| **Filter by topic** | Topic dropdown (cluster label) |
| **Filter by session** | Session dropdown |
| **Favorites** | Star an abstract to save it |
| **Calendar** | Download a calendar file for the current list or favorites only |
| **Table browser** | Bottom panel; resize with the divider |
| **Reset view** | Reset zoom and pan |

---

## Development

```bash
cd app && npm install
npm run dev          # dev server
npm run build        # production bundle (expects app/public/aacr_data.json)
```

### Build `aacr_data.json`

```bash
# 1. Program guide -> aacr_program_guide.json (posters-only: echo '[]' > aacr_program_guide.json)
uv run scrape_program_guide_pdf.py

# 2. Merge posters + talks, then embed
uv run merge_aacr_sources.py
uv run precompute_embeddings.py
```

`merge_aacr_sources.py` defaults: `--posters aacr_abstracts.json`, `--talks aacr_program_guide.json`, `--out app/public/aacr_data.json`.

Deploying to GitHub Pages runs `npm run build` in `app/` via `.github/workflows/deploy.yml`. Commit `app/public/aacr_data.json` if the site should ship with data (file is large).

---

## Scripts (this repo)

| Script | Role |
|--------|------|
| `scrape_program_guide_pdf.py` | PDF → `aacr_program_guide.json` |
| `merge_aacr_sources.py` | `aacr_abstracts.json` + program guide → `app/public/aacr_data.json` |
| `precompute_embeddings.py` | Adds coordinates and cluster topics to `app/public/aacr_data.json` |
