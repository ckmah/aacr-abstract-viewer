#!/usr/bin/env node
/**
 * Precompute 2D embeddings for AACR abstracts.
 * Reads aacr_abstracts.json, normalizes, computes PCA embeddings,
 * and writes aacr_data.json (normalized abstracts with x,y coords baked in).
 */
const fs = require("fs");

/* ── Parse HTML author block into clean names ── */
function parseAuthors(html) {
  if (!html) return [];
  const stripped = html
    .replace(/<sup>.*?<\/sup>/gi, "")
    .replace(/<br\s*\/?>/gi, "|")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&#\d+;/g, "");
  const authorLine = stripped.split("|")[0];
  return authorLine
    .split(",")
    .map((a) => a.trim())
    .filter((a) => a.length > 1 && a.length < 80);
}

function parseInstitution(html) {
  if (!html) return "";
  const parts = html.replace(/<[^>]+>/g, "").split(/\|/);
  return (parts[parts.length - 1] || "").trim();
}

function stripHtml(html) {
  if (!html) return "";
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&#62;/g, ">")
    .replace(/&#60;/g, "<")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .trim();
}

function inferCancerType(text) {
  const t = (text || "").toLowerCase();
  const map = [
    [/breast/i, "Breast Cancer"],
    [/lung|nsclc|sclc/i, "Lung Cancer"],
    [/colorectal|colon\b|crc\b/i, "Colorectal Cancer"],
    [/pancrea/i, "Pancreatic Cancer"],
    [/melanoma/i, "Melanoma"],
    [/prostate/i, "Prostate Cancer"],
    [/ovarian/i, "Ovarian Cancer"],
    [/glioblastoma|gbm|glioma|brain\s+tumor/i, "Glioblastoma/Brain"],
    [/hepatocellular|liver|hcc\b/i, "Liver Cancer"],
    [/renal|kidney|rcc\b/i, "Renal Cell Carcinoma"],
    [/bladder|urothelial/i, "Bladder Cancer"],
    [/head.and.neck|hnscc|oral.cancer/i, "Head & Neck"],
    [/leukemia|aml\b|cll\b/i, "Leukemia"],
    [/lymphoma|dlbcl/i, "Lymphoma"],
    [/gastric|stomach/i, "Gastric Cancer"],
    [/endometrial|uterine/i, "Endometrial Cancer"],
    [/thyroid/i, "Thyroid Cancer"],
    [/sarcoma/i, "Sarcoma"],
    [/myeloma/i, "Multiple Myeloma"],
    [/cervical/i, "Cervical Cancer"],
    [/esophag/i, "Esophageal Cancer"],
    [/mesothelioma/i, "Mesothelioma"],
    [/neuroblastoma/i, "Neuroblastoma"],
  ];
  for (const [re, label] of map) {
    if (re.test(t)) return label;
  }
  return "Pan-Cancer / Other";
}

function parseTopics(topicsStr) {
  if (!topicsStr) return [];
  return topicsStr
    .replace(/\+\+/g, "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

function normalizeAbstracts(raw) {
  return raw.map((d) => ({
    id: d.controlNumber || d.id,
    internalId: d.id,
    title: d.title || "",
    authors: parseAuthors(d.authorBlock),
    institution: parseInstitution(d.authorBlock),
    session: d.sessionTitle || "",
    cancerType: inferCancerType((d.title || "") + " " + stripHtml(d.abstract)),
    topics: parseTopics(d.topics),
    keywords: parseTopics(d.keywords),
    posterNumber: d.posterboardNumber || d.presentationNumber || "",
    abstract: stripHtml(d.abstract),
    presenter: d.presenter || "",
    start: d.start || "",
  }));
}

/* ── 2D Embedding via PCA on topic vectors ── */
function computeEmbedding(abstracts) {
  const vocab = new Map();
  let idx = 0;
  abstracts.forEach((a) => {
    const tags = [...a.topics, ...a.keywords, a.cancerType, ...a.session.split(/[\s:,]+/).filter(w => w.length > 3)];
    tags.forEach((t) => {
      const key = t.toLowerCase();
      if (!vocab.has(key)) vocab.set(key, idx++);
    });
  });

  const dim = vocab.size;
  if (dim === 0) {
    return abstracts.map(() => ({ x: Math.random(), y: Math.random() }));
  }

  const vectors = abstracts.map((a) => {
    const tags = [...a.topics, ...a.keywords, a.cancerType, ...a.session.split(/[\s:,]+/).filter(w => w.length > 3)];
    const vec = new Float32Array(dim);
    tags.forEach((t) => {
      const i = vocab.get(t.toLowerCase());
      if (i !== undefined) vec[i] = 1;
    });
    return vec;
  });

  const n = vectors.length;
  const mean = new Float32Array(dim);
  vectors.forEach((v) => v.forEach((val, j) => (mean[j] += val / n)));
  const centered = vectors.map((v) => {
    const c = new Float32Array(dim);
    for (let j = 0; j < dim; j++) c[j] = v[j] - mean[j];
    return c;
  });

  function seededRandom(seed) {
    let s = seed;
    return () => { s = (s * 16807 + 0) % 2147483647; return (s - 1) / 2147483646; };
  }
  const rng = seededRandom(123);

  function powerIteration(mat, deflate = null) {
    let vec = new Float32Array(dim);
    for (let i = 0; i < dim; i++) vec[i] = rng() - 0.5;
    for (let iter = 0; iter < 30; iter++) {
      const proj = mat.map((row) => {
        let s = 0;
        for (let j = 0; j < dim; j++) s += row[j] * vec[j];
        return s;
      });
      const newVec = new Float32Array(dim);
      mat.forEach((row, i) => {
        for (let j = 0; j < dim; j++) newVec[j] += proj[i] * row[j];
      });
      if (deflate) {
        let dot = 0;
        for (let j = 0; j < dim; j++) dot += newVec[j] * deflate[j];
        for (let j = 0; j < dim; j++) newVec[j] -= dot * deflate[j];
      }
      let norm = 0;
      for (let j = 0; j < dim; j++) norm += newVec[j] * newVec[j];
      norm = Math.sqrt(norm) || 1;
      for (let j = 0; j < dim; j++) vec[j] = newVec[j] / norm;
    }
    return vec;
  }

  const pc1 = powerIteration(centered);
  const pc2 = powerIteration(centered, pc1);

  const proj = centered.map((row) => {
    let x = 0, y = 0;
    for (let j = 0; j < dim; j++) {
      x += row[j] * pc1[j];
      y += row[j] * pc2[j];
    }
    return { x, y };
  });

  const jitterRng = seededRandom(999);
  proj.forEach((p) => {
    p.x += (jitterRng() - 0.5) * 0.12;
    p.y += (jitterRng() - 0.5) * 0.12;
  });

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  proj.forEach((p) => {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  });
  const rangeX = maxX - minX || 1;
  const rangeY = maxY - minY || 1;

  return proj.map((p) => ({
    x: +((p.x - minX) / rangeX).toFixed(5),
    y: +((p.y - minY) / rangeY).toFixed(5),
  }));
}

/* ── Main ── */
const rawPath = "aacr_abstracts.json";
const outPath = "app/public/aacr_data.json";

console.log(`Reading ${rawPath}...`);
const raw = JSON.parse(fs.readFileSync(rawPath, "utf-8"));
console.log(`Normalizing ${raw.length} abstracts...`);
const abstracts = normalizeAbstracts(raw);
console.log(`Computing embeddings (vocab-based PCA)...`);
const embeddings = computeEmbedding(abstracts);

// Bake x,y into each abstract
const output = abstracts.map((a, i) => ({
  ...a,
  x: embeddings[i].x,
  y: embeddings[i].y,
}));

fs.writeFileSync(outPath, JSON.stringify(output));
const sizeMB = (fs.statSync(outPath).size / 1024 / 1024).toFixed(1);
console.log(`Wrote ${outPath} (${output.length} abstracts, ${sizeMB} MB)`);
