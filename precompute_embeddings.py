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

# ── Step 1: Load and encode ──────────────────────────────────────────────────

print("Loading abstracts...")
with open(DATA_PATH) as f:
    abstracts = json.load(f)
print(f"Loaded {len(abstracts)} abstracts")

# Build text: title + abstract only (no tags/topics/keywords)
texts = []
for a in abstracts:
    title = a.get("title", "")
    body = a.get("abstract", "")
    text = f"{title}. {body}" if body else title
    texts.append(text[:2000])

print("Loading SentenceTransformer model (all-MiniLM-L6-v2)...")
model = SentenceTransformer("all-MiniLM-L6-v2")

print("Encoding abstracts...")
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

cluster_topic_labels = {}
for c in range(N_CLUSTERS):
    mask = labels == c
    cluster_tfidf = tfidf_matrix[mask].mean(axis=0).A1
    top_indices = cluster_tfidf.argsort()[-20:][::-1]
    candidates = [feature_names[i] for i in top_indices]

    # Pick the single best 1-2 word candidate: highest cosine sim to centroid
    centroid = embeddings[mask].mean(axis=0, keepdims=True)
    # Prefer shorter candidates (1-2 words) that are descriptive
    short_cands = [c for c in candidates if len(c.split()) <= 2]
    if not short_cands:
        short_cands = candidates[:5]
    cand_embs = model.encode(short_cands)
    sims = util.cos_sim(centroid, cand_embs)[0].cpu().numpy()
    best = short_cands[sims.argmax()]
    topic_label = best.title()
    cluster_topic_labels[c] = topic_label
    print(f"  Cluster {c:2d} ({mask.sum():4d} abstracts): {topic_label}")

# Assign each abstract its cluster's topic label
for i, a in enumerate(abstracts):
    a["x"] = round(float(coords_norm[i, 0]), 5)
    a["y"] = round(float(coords_norm[i, 1]), 5)
    a["z"] = round(float(coords_norm[i, 2]), 5)
    a["cluster"] = int(labels[i])
    a["clusterTopic"] = cluster_topic_labels[int(labels[i])]

# ── Step 4: Write output ─────────────────────────────────────────────────────

print(f"Writing {OUT_PATH}...")
with open(OUT_PATH, "w") as f:
    json.dump(abstracts, f)

size_mb = os.path.getsize(OUT_PATH) / 1024 / 1024
print(f"Done! {len(abstracts)} abstracts, {size_mb:.1f} MB")
