#!/usr/bin/env python3
# /// script
# requires-python = ">=3.9"
# dependencies = [
#     "sentence-transformers",
#     "umap-learn",
#     "numpy",
#     "scikit-learn",
# ]
# ///
"""
Precompute 2D embeddings and extract topics for AACR abstracts.

1. Encode title+abstract with SentenceTransformer (all-MiniLM-L6-v2)
2. Reduce to 2D with UMAP for the scatter plot
3. Cluster with KMeans, then extract topic labels per cluster using
   the model's semantic similarity against candidate labels

Usage: uv run precompute_embeddings.py
"""
import json
import os

import numpy as np
from sentence_transformers import SentenceTransformer, util
from sklearn.cluster import KMeans
from sklearn.feature_extraction.text import TfidfVectorizer
from umap import UMAP

DATA_PATH = "app/public/aacr_data.json"
OUT_PATH = "app/public/aacr_data.json"

SKIPPED_CLUSTER_ID = 99
SKIPPED_TOPIC_LABEL = "Agenda"


def _embedding_text(a: dict) -> str:
    title = a.get("title", "")
    body = a.get("abstract", "")
    text = f"{title}. {body}" if body else title
    return text[:2000]


# ── Step 1: Load and encode ──────────────────────────────────────────────────

print("Loading abstracts...")
with open(DATA_PATH) as f:
    abstracts = json.load(f)
print(f"Loaded {len(abstracts)} abstracts")

embed_mask = [a.get("includeInSemanticMap", True) for a in abstracts]
embed_idx = [i for i, m in enumerate(embed_mask) if m]
skip_idx = [i for i, m in enumerate(embed_mask) if not m]
print(f"  Semantic map: {len(embed_idx)} rows; agenda-only (no embed): {len(skip_idx)}")

if not embed_idx:
    raise SystemExit("No rows with includeInSemanticMap=true; nothing to embed.")

texts_all = [_embedding_text(a) for a in abstracts]
texts = [texts_all[i] for i in embed_idx]

print("Loading SentenceTransformer model (all-MiniLM-L6-v2)...")
model = SentenceTransformer("all-MiniLM-L6-v2")

print("Encoding abstracts (semantic-map rows only)...")
embeddings = model.encode(texts, show_progress_bar=True, batch_size=64)
print(f"Embeddings shape: {embeddings.shape}")

# ── Step 2: UMAP to 2D ──────────────────────────────────────────────────────

print("Running UMAP reduction to 3D...")
reducer = UMAP(
    n_components=3, n_neighbors=30, min_dist=0.1,
    metric="cosine", random_state=42
)
coords_3d = reducer.fit_transform(embeddings)

mins = coords_3d.min(axis=0)
maxs = coords_3d.max(axis=0)
ranges = maxs - mins
ranges[ranges == 0] = 1
coords_norm = (coords_3d - mins) / ranges

# ── Step 3: Extract topics via clustering + TF-IDF + semantic ranking ────────

N_CLUSTERS = 40
print(f"Clustering into {N_CLUSTERS} groups...")
km = KMeans(n_clusters=N_CLUSTERS, random_state=42, n_init=10)
labels = km.fit_predict(embeddings)

# For each cluster, extract top TF-IDF terms as candidate topic phrases
print("Extracting topic labels per cluster...")
tfidf = TfidfVectorizer(
    max_features=5000, stop_words="english",
    ngram_range=(1, 3), min_df=2, max_df=0.3
)
tfidf_matrix = tfidf.fit_transform(texts)
feature_names = tfidf.get_feature_names_out()

cluster_topic_labels: dict[int, str] = {SKIPPED_CLUSTER_ID: SKIPPED_TOPIC_LABEL}
for c in range(N_CLUSTERS):
    mask = labels == c
    cluster_tfidf = tfidf_matrix[mask].mean(axis=0).A1
    top_indices = cluster_tfidf.argsort()[-20:][::-1]
    candidates = [feature_names[i] for i in top_indices]

    # Pick the single best 1-2 word candidate: highest cosine sim to centroid
    centroid = embeddings[mask].mean(axis=0, keepdims=True)
    # Prefer shorter candidates (1-2 words) that are descriptive
    short_cands = [x for x in candidates if len(x.split()) <= 2]
    if not short_cands:
        short_cands = candidates[:5]
    cand_embs = model.encode(short_cands)
    sims = util.cos_sim(centroid, cand_embs)[0].cpu().numpy()
    best = short_cands[sims.argmax()]
    topic_label = best.title()
    cluster_topic_labels[c] = topic_label
    print(f"  Cluster {c:2d} ({mask.sum():4d} abstracts): {topic_label}")

# Assign coordinates and cluster labels (agenda-only rows: placeholder coords, no embed)
for j, i in enumerate(embed_idx):
    a = abstracts[i]
    a["x"] = round(float(coords_norm[j, 0]), 5)
    a["y"] = round(float(coords_norm[j, 1]), 5)
    a["z"] = round(float(coords_norm[j, 2]), 5)
    a["cluster"] = int(labels[j])
    a["clusterTopic"] = cluster_topic_labels[int(labels[j])]

for i in skip_idx:
    a = abstracts[i]
    a["x"] = 0.5
    a["y"] = 0.5
    a["z"] = 0.5
    a["cluster"] = SKIPPED_CLUSTER_ID
    a["clusterTopic"] = SKIPPED_TOPIC_LABEL

# ── Step 4: Write output ─────────────────────────────────────────────────────

print(f"Writing {OUT_PATH}...")
with open(OUT_PATH, "w") as f:
    json.dump(abstracts, f)

size_mb = os.path.getsize(OUT_PATH) / 1024 / 1024
print(f"Done! {len(abstracts)} abstracts, {size_mb:.1f} MB")
