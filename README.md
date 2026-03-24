# AACR 2026 Abstract Explorer

An interactive browser for **6,717 poster session abstracts** from the [AACR Annual Meeting 2026](https://www.aacr.org/meeting/aacr-annual-meeting-2026/). Abstracts are embedded into a 2D semantic map so that similar research clusters together visually — you can pan, zoom, search, and explore the landscape of cancer research presented at the meeting.

**Live app:** https://ckmah.github.io/aacr-abstract-viewer/

---

## Data source

Abstracts were scraped from [abstractsonline.com](https://www.abstractsonline.com) (the official AACR abstract submission and viewing platform) using a Playwright-based browser script (`scrape_aacr.js`) that authenticates with a session cookie and pages through the poster session listing API. The raw data includes title, authors, institution, session, topics, keywords, and full abstract text.

---

## Embedding pipeline

```
Raw abstracts (abstractsonline.com)
           │
           ▼
    scrape_aacr.js
    ─────────────────────────────────────────────────
    Playwright browser automation
    Paginates poster listing API (~6,700 abstracts)
    Extracts: title, authors, abstract HTML, session,
              topics, keywords, poster number
           │
           ▼
  precompute_embeddings.py  (uv run)
  ─────────────────────────────────────────────────────────────────────
  │                                                                    │
  │  Step 1 — Text preparation                                         │
  │  Concatenate title + abstract text (strip HTML, cap at 2,000 chars)│
  │                                                                    │
  │  Step 2 — Sentence encoding                                        │
  │  SentenceTransformer("all-MiniLM-L6-v2")                           │
  │  → 384-dimensional dense vector per abstract                       │
  │                                                                    │
  │  Step 3 — Dimensionality reduction                                 │
  │  UMAP(n_components=2, n_neighbors=30, metric="cosine")             │
  │  → (x, y) coordinates in [0, 1] space                             │
  │                                                                    │
  │  Step 4 — Clustering + topic labeling                              │
  │  KMeans(k=40) on 384-d embeddings                                  │
  │  TF-IDF on cluster members → top candidate terms                   │
  │  Cosine similarity of candidate embeddings to cluster centroid     │
  │  → single best 1–2 word topic label per cluster                    │
  └────────────────────────────────────────────────────────────────────
           │
           ▼
   app/public/aacr_data.json
   (6,717 abstracts with x, y, cluster, clusterTopic baked in)
           │
           ▼
   React + Canvas app  →  https://ckmah.github.io/aacr-abstract-viewer/
```

Abstracts about similar biology (e.g. CAR-T therapy, KRAS inhibitors, DNA damage response) appear close together on the map. Distant points represent research with little semantic overlap.

---

## Interactive features

| Feature | How to use |
|---|---|
| **Pan** | Click and drag the canvas |
| **Zoom** | Scroll wheel — zooms anchored to cursor position |
| **Hover** | Hover a point to see title, authors, and session in a tooltip |
| **Select** | Click a point to open the full abstract in the detail panel |
| **Semantic search** | Type in the search box — points are colored by cosine similarity to your query (bright = most similar) |
| **Filter by topic** | Use the Topic dropdown to show only abstracts in a given cluster topic |
| **Filter by session** | Use the Session dropdown to restrict to a specific poster session |
| **Favorites** | Click the star icon on any abstract to save it |
| **Export all** | Download all abstracts as `aacr_abstracts_all.csv` |
| **Export favorites** | Download only starred abstracts as `aacr_abstracts_fav.csv` |
| **Table browser** | Toggle the bottom panel to browse and sort all abstracts in a table; drag the divider to resize |
| **Reset view** | Click the Reset button to return to the default zoom and pan |

---

## Development

```bash
# Install dependencies
cd app && npm install

# Start dev server
npm run dev

# Build for production
npm run build
```

Deploying to GitHub Pages is automatic on push to `main` via `.github/workflows/deploy.yml`.

To regenerate embeddings after updating the raw data:

```bash
uv run precompute_embeddings.py
```
