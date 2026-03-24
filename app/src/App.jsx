import { useState, useEffect, useRef, useCallback, useMemo } from "react";

/* ── Color palette (40 clusters) ── */
const PALETTE = [
  "#00ff9f", "#00b8ff", "#ff6b6b", "#ffd93d", "#c084fc", "#fb923c",
  "#34d399", "#f472b6", "#60a5fa", "#a78bfa", "#facc15", "#4ade80",
  "#f87171", "#38bdf8", "#e879f9", "#f97316", "#14b8a6", "#8b5cf6",
  "#ef4444", "#06b6d4", "#d946ef", "#22d3ee", "#a3e635", "#f59e0b",
  "#10b981", "#ec4899", "#6366f1", "#84cc16", "#f43f5e", "#0ea5e9",
  "#a855f7", "#eab308", "#14b8a6", "#e11d48", "#7c3aed", "#2dd4bf",
  "#fb7185", "#818cf8", "#fbbf24", "#4f46e5",
];

/* ── Similarity heat color (blue → orange → white) ── */
function similarityColor(sim) {
  if (sim > 0.85) {
    const t = (sim - 0.85) / 0.15;
    return `rgb(${255},${Math.round(180 + 75 * t)},${Math.round(80 + 175 * t)})`;
  }
  if (sim > 0.5) {
    const t = (sim - 0.5) / 0.35;
    return `rgb(${Math.round(80 + 175 * t)},${Math.round(40 + 140 * t)},${Math.round(180 - 100 * t)})`;
  }
  const t = sim / 0.5;
  return `rgb(${Math.round(20 + 60 * t)},${Math.round(20 + 20 * t)},${Math.round(50 + 130 * t)})`;
}

/* ── Lerp helper ── */
function lerp(a, b, t) { return a + (b - a) * t; }

/* ── Main App ── */
export default function AACRExplorer() {
  const [abstracts, setAbstracts] = useState([]);
  const [embeddings, setEmbeddings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingStatus, setLoadingStatus] = useState("Fetching abstracts...");

  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const [dimensions, setDimensions] = useState({ w: window.innerWidth, h: window.innerHeight });
  const dimensionsRef = useRef({ w: window.innerWidth, h: window.innerHeight });
  const [camera, setCamera] = useState({ x: 0, y: 0, zoom: 1 });
  const [hoveredId, setHoveredId] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [favorites, setFavorites] = useState(new Set());
  const [searchTerm, setSearchTerm] = useState("");
  const [filterTopic, setFilterTopic] = useState("All");
  const [filterSession, setFilterSession] = useState("All");
  const [showFavoritesOnly, setShowFavoritesOnly] = useState(false);
  const [showLegend, setShowLegend] = useState(false);
  const [showTable, setShowTable] = useState(false);
  const [tableHeight, setTableHeight] = useState(350);
  const [tooltipData, setTooltipData] = useState(null);
  const [tablePage, setTablePage] = useState(0);
  const TABLE_PAGE_SIZE = 50;

  const dragRef = useRef({ dragging: false, lastX: 0, lastY: 0, moved: false });

  // Smooth zoom animation
  const animCameraRef = useRef({ x: 0, y: 0, zoom: 1 });
  const targetCameraRef = useRef({ x: 0, y: 0, zoom: 1 });
  const animFrameRef = useRef(null);

  const animateCamera = useCallback(() => {
    const cur = animCameraRef.current;
    const tgt = targetCameraRef.current;
    const t = 0.25; // interpolation speed
    const nx = lerp(cur.x, tgt.x, t);
    const ny = lerp(cur.y, tgt.y, t);
    const nz = lerp(cur.zoom, tgt.zoom, t);
    animCameraRef.current = { x: nx, y: ny, zoom: nz };

    const dx = Math.abs(nx - tgt.x);
    const dy = Math.abs(ny - tgt.y);
    const dz = Math.abs(nz - tgt.zoom);
    setCamera({ x: nx, y: ny, zoom: nz });

    if (dx > 0.1 || dy > 0.1 || dz > 0.001) {
      animFrameRef.current = requestAnimationFrame(animateCamera);
    } else {
      animCameraRef.current = { ...tgt };
      setCamera({ ...tgt });
      animFrameRef.current = null;
    }
  }, []);

  const smoothSetCamera = useCallback((updater) => {
    const cur = targetCameraRef.current;
    const next = typeof updater === "function" ? updater(cur) : updater;
    targetCameraRef.current = next;
    if (!animFrameRef.current) {
      animFrameRef.current = requestAnimationFrame(animateCamera);
    }
  }, [animateCamera]);

  // Direct camera set (for drag — no animation)
  const directSetCamera = useCallback((updater) => {
    const cur = animCameraRef.current;
    const next = typeof updater === "function" ? updater(cur) : updater;
    animCameraRef.current = next;
    targetCameraRef.current = next;
    setCamera(next);
  }, []);

  // Load precomputed data
  useEffect(() => {
    (async () => {
      try {
        const resp = await fetch(import.meta.env.BASE_URL + "aacr_data.json");
        const data = await resp.json();
        setLoadingStatus(`Loading ${data.length} abstracts...`);
        const emb = data.map((d) => ({ x: d.x, y: d.y }));
        setAbstracts(data);
        setEmbeddings(emb);
        setLoading(false);
      } catch (e) {
        setLoadingStatus(`Error: ${e.message}`);
      }
    })();
  }, []);

  // Load favorites
  useEffect(() => {
    try {
      const saved = localStorage.getItem("aacr-favorites");
      if (saved) setFavorites(new Set(JSON.parse(saved)));
    } catch {}
  }, []);

  const saveFavorites = useCallback((newFavs) => {
    setFavorites(newFavs);
    try { localStorage.setItem("aacr-favorites", JSON.stringify([...newFavs])); } catch {}
  }, []);

  const toggleFavorite = useCallback((id) => {
    setFavorites((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      saveFavorites(next);
      return next;
    });
  }, [saveFavorites]);

  // Resize
  const dprRef = useRef(window.devicePixelRatio || 1);
  useEffect(() => {
    const update = () => {
      if (!containerRef.current) return;
      const { width, height } = containerRef.current.getBoundingClientRect();
      dprRef.current = window.devicePixelRatio || 1;
      dimensionsRef.current = { w: width, h: height };
      setDimensions({ w: width, h: height });
    };
    const obs = new ResizeObserver(update);
    if (containerRef.current) obs.observe(containerRef.current);
    const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    const onDprChange = () => update();
    mq.addEventListener?.("change", onDprChange);
    return () => { obs.disconnect(); mq.removeEventListener?.("change", onDprChange); };
  }, []);

  // Derived data
  const clusterTopics = useMemo(() => {
    const counts = {};
    abstracts.forEach((a) => { const t = a.clusterTopic || "Unknown"; counts[t] = (counts[t] || 0) + 1; });
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([topic, count]) => ({ topic, count }));
  }, [abstracts]);

  const sessions = useMemo(() => [...new Set(abstracts.map((a) => a.session))].sort(), [abstracts]);

  const clusterColors = useMemo(() => {
    const colors = {};
    abstracts.forEach((a) => {
      if (a.cluster !== undefined && !(a.cluster in colors))
        colors[a.cluster] = PALETTE[a.cluster % PALETTE.length];
    });
    return colors;
  }, [abstracts]);

  const topicColors = useMemo(() => {
    const colors = {};
    abstracts.forEach((a) => {
      const t = a.clusterTopic || "Unknown";
      if (!(t in colors) && a.cluster !== undefined) colors[t] = clusterColors[a.cluster] || "#ffffff";
    });
    return colors;
  }, [abstracts, clusterColors]);

  // Search-based similarity: compute distance from centroid of search matches
  const searchSimilarity = useMemo(() => {
    if (!searchTerm || searchTerm.length < 2 || embeddings.length === 0) return null;
    const term = searchTerm.toLowerCase();
    // Find matching indices
    const matches = [];
    abstracts.forEach((a, i) => {
      if (a.title.toLowerCase().includes(term) || a.authors.join(" ").toLowerCase().includes(term) || a.id.toLowerCase().includes(term) || a.presenter.toLowerCase().includes(term))
        matches.push(i);
    });
    if (matches.length === 0) return null;

    // Compute centroid of matches in 2D
    let cx = 0, cy = 0;
    matches.forEach((i) => { cx += embeddings[i].x; cy += embeddings[i].y; });
    cx /= matches.length; cy /= matches.length;

    // Distance from every point to centroid
    const dists = embeddings.map((e) => Math.hypot(e.x - cx, e.y - cy));
    const maxDist = Math.max(...dists) || 1;
    return dists.map((d) => 1 - d / maxDist);
  }, [searchTerm, abstracts, embeddings]);

  // Filtered abstracts
  const filteredIndices = useMemo(() => {
    const term = searchTerm.toLowerCase();
    return abstracts.map((_, i) => i).filter((i) => {
      const a = abstracts[i];
      if (showFavoritesOnly && !favorites.has(a.id)) return false;
      if (filterTopic !== "All" && a.clusterTopic !== filterTopic) return false;
      if (filterSession !== "All" && a.session !== filterSession) return false;
      if (term && !a.title.toLowerCase().includes(term) && !a.authors.join(" ").toLowerCase().includes(term) && !a.id.toLowerCase().includes(term) && !a.presenter.toLowerCase().includes(term)) return false;
      return true;
    });
  }, [abstracts, searchTerm, filterTopic, filterSession, showFavoritesOnly, favorites]);

  const filteredSet = useMemo(() => new Set(filteredIndices), [filteredIndices]);

  // World -> Screen
  const worldToScreen = useCallback((wx, wy) => {
    const margin = 60;
    const scale = Math.min(dimensions.w - margin * 2, dimensions.h - margin * 2) * camera.zoom;
    return {
      sx: dimensions.w / 2 + (wx - 0.5) * scale + camera.x,
      sy: dimensions.h / 2 + (wy - 0.5) * scale + camera.y,
    };
  }, [dimensions, camera]);

  // Canvas render
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || abstracts.length === 0 || embeddings.length === 0) return;
    const ctx = canvas.getContext("2d");
    const dpr = dprRef.current;
    const bufW = Math.round(dimensions.w * dpr);
    const bufH = Math.round(dimensions.h * dpr);
    if (canvas.width !== bufW || canvas.height !== bufH) { canvas.width = bufW; canvas.height = bufH; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.fillStyle = "#08090d";
    ctx.fillRect(0, 0, dimensions.w, dimensions.h);

    // Grid
    ctx.strokeStyle = "rgba(255,255,255,0.02)";
    ctx.lineWidth = 1;
    const gridStep = 50 * camera.zoom;
    const offsetX = (((camera.x % gridStep) + gridStep) % gridStep);
    const offsetY = (((camera.y % gridStep) + gridStep) % gridStep);
    for (let x = offsetX; x < dimensions.w; x += gridStep) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, dimensions.h); ctx.stroke(); }
    for (let y = offsetY; y < dimensions.h; y += gridStep) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(dimensions.w, y); ctx.stroke(); }

    const baseRadius = Math.max(2, 3 * camera.zoom);
    const useSimilarity = searchSimilarity !== null;

    // Dimmed (non-filtered) points
    abstracts.forEach((a, i) => {
      if (filteredSet.has(i)) return;
      const { sx, sy } = worldToScreen(embeddings[i].x, embeddings[i].y);
      if (sx < -20 || sx > dimensions.w + 20 || sy < -20 || sy > dimensions.h + 20) return;
      ctx.beginPath();
      ctx.arc(sx, sy, baseRadius * 0.5, 0, Math.PI * 2);
      ctx.fillStyle = useSimilarity ? similarityColor(searchSimilarity[i] * 0.3) : "rgba(255,255,255,0.04)";
      ctx.fill();
    });

    // Active points
    filteredIndices.forEach((i) => {
      const a = abstracts[i];
      const { sx, sy } = worldToScreen(embeddings[i].x, embeddings[i].y);
      if (sx < -20 || sx > dimensions.w + 20 || sy < -20 || sy > dimensions.h + 20) return;

      const color = useSimilarity ? similarityColor(searchSimilarity[i]) : (clusterColors[a.cluster] || "#ffffff");
      const isFav = favorites.has(a.id);
      const isHovered = hoveredId === i;
      const isSelected = selectedId === i;
      const r = isHovered || isSelected ? baseRadius * 2 : isFav ? baseRadius * 1.4 : baseRadius;

      if (isHovered || isSelected) {
        const grad = ctx.createRadialGradient(sx, sy, r, sx, sy, r + 14);
        grad.addColorStop(0, (useSimilarity ? "#ffffff" : color) + "33");
        grad.addColorStop(1, (useSimilarity ? "#ffffff" : color) + "00");
        ctx.beginPath();
        ctx.arc(sx, sy, r + 14, 0, Math.PI * 2);
        ctx.fillStyle = grad;
        ctx.fill();
      }

      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fillStyle = isHovered || isSelected ? color : color + (useSimilarity ? "" : "bb");
      ctx.fill();

      if (isFav) {
        ctx.beginPath();
        ctx.arc(sx, sy, r + 3, 0, Math.PI * 2);
        ctx.strokeStyle = "#ffd93d88";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    });

    // Crosshair
    ctx.strokeStyle = "rgba(255,255,255,0.04)";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 8]);
    ctx.beginPath(); ctx.moveTo(dimensions.w / 2, 0); ctx.lineTo(dimensions.w / 2, dimensions.h); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, dimensions.h / 2); ctx.lineTo(dimensions.w, dimensions.h / 2); ctx.stroke();
    ctx.setLineDash([]);
  }, [dimensions, camera, abstracts, embeddings, filteredIndices, filteredSet, favorites, hoveredId, selectedId, worldToScreen, clusterColors, searchSimilarity]);

  // Hit test
  const hitTest = useCallback((mx, my) => {
    const baseRadius = Math.max(2, 3 * camera.zoom);
    let closest = -1, closestDist = Infinity;
    filteredIndices.forEach((i) => {
      const { sx, sy } = worldToScreen(embeddings[i].x, embeddings[i].y);
      const d = Math.hypot(mx - sx, my - sy);
      if (d < Math.max(baseRadius * 3, 14) && d < closestDist) { closest = i; closestDist = d; }
    });
    return closest;
  }, [camera, filteredIndices, embeddings, worldToScreen]);

  // Mouse handlers
  const handleMouseDown = (e) => { dragRef.current = { dragging: true, lastX: e.clientX, lastY: e.clientY, moved: false }; };
  const handleMouseMove = (e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    if (dragRef.current.dragging) {
      const dx = e.clientX - dragRef.current.lastX, dy = e.clientY - dragRef.current.lastY;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) dragRef.current.moved = true;
      directSetCamera((c) => ({ ...c, x: c.x + dx, y: c.y + dy }));
      dragRef.current.lastX = e.clientX; dragRef.current.lastY = e.clientY;
      setHoveredId(null); setTooltipData(null);
      return;
    }
    const hit = hitTest(mx, my);
    setHoveredId(hit >= 0 ? hit : null);
    setTooltipData(hit >= 0 ? { x: mx, y: my, abstract: abstracts[hit] } : null);
  };
  const handleMouseUp = () => { dragRef.current.dragging = false; };
  const handleClick = (e) => {
    if (dragRef.current.moved) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const hit = hitTest(e.clientX - rect.left, e.clientY - rect.top);
    setSelectedId(hit >= 0 ? hit : null);
  };

  // Wheel zoom — smooth animated, centered at cursor
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const { w, h } = dimensionsRef.current;
      // ox/oy: cursor position relative to canvas center (same space as camera.x/y)
      const ox = (e.clientX - rect.left) - w / 2;
      const oy = (e.clientY - rect.top) - h / 2;
      const factor = e.deltaY > 0 ? 0.85 : 1.18;
      smoothSetCamera((c) => {
        const newZoom = Math.max(0.2, Math.min(10, c.zoom * factor));
        const scale = newZoom / c.zoom;
        return { x: ox - scale * (ox - c.x), y: oy - scale * (oy - c.y), zoom: newZoom };
      });
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [loading, smoothSetCamera]);

  // Table resize drag
  const tableResizeRef = useRef(null);
  const handleTableResizeStart = (e) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = tableHeight;
    const onMove = (ev) => {
      const delta = startY - ev.clientY;
      setTableHeight(Math.max(150, Math.min(window.innerHeight * 0.8, startH + delta)));
    };
    const onUp = () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  // CSV Export
  const exportCSV = (favOnly = false) => {
    const items = favOnly ? abstracts.filter((a) => favorites.has(a.id)) : filteredIndices.map((i) => abstracts[i]);
    const escape = (s) => `"${String(s).replace(/"/g, '""')}"`;
    const header = "ID,Title,Authors,Institution,Session,Topic,Poster Number,Presenter,Abstract";
    const rows = items.map((a) =>
      [a.id, a.title, a.authors.join("; "), a.institution, a.session, a.clusterTopic, a.posterNumber, a.presenter, a.abstract.replace(/\n/g, " ")].map(escape).join(",")
    );
    const blob = new Blob([[header, ...rows].join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = favOnly ? "aacr_abstracts_fav.csv" : "aacr_abstracts_all.csv";
    link.click();
    URL.revokeObjectURL(url);
  };

  const selected = selectedId !== null ? abstracts[selectedId] : null;
  const tableData = useMemo(() => filteredIndices.map((i) => abstracts[i]), [filteredIndices, abstracts]);
  const tablePageData = useMemo(() => tableData.slice(tablePage * TABLE_PAGE_SIZE, (tablePage + 1) * TABLE_PAGE_SIZE), [tableData, tablePage]);
  const totalTablePages = Math.ceil(tableData.length / TABLE_PAGE_SIZE);

  if (loading) {
    return (
      <div style={{ width: "100vw", height: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: "#08090d", color: "#3a3e4a", fontFamily: "'JetBrains Mono', 'Fira Code', monospace" }}>
        <style>{`
          @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500&family=DM+Sans:wght@400;500;600;700&display=swap');
          @keyframes pulse { 0%,100% { opacity: 0.3; } 50% { opacity: 1; } }
        `}</style>
        <div style={{ fontSize: 16, letterSpacing: 6, textTransform: "uppercase", marginBottom: 36, color: "#00ff9f", animation: "pulse 2s infinite" }}>AACR 2026 Explorer</div>
        <div style={{ fontSize: 18, color: "#2a2e3a" }}>{loadingStatus}</div>
      </div>
    );
  }

  return (
    <div style={{ width: "100vw", height: "100vh", overflow: "hidden", background: "#08090d", color: "#c8ccd4", fontFamily: "'JetBrains Mono', 'Fira Code', monospace", position: "relative" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500&family=DM+Sans:ital,wght@0,400;0,500;0,600;0,700;1,400&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { width: 8px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 4px; }

        .ctrl-bar { position: absolute; top: 0; left: 0; right: 0; z-index: 10; display: flex; align-items: center; gap: 12px; padding: 14px 20px; background: linear-gradient(180deg, rgba(8,9,13,0.97) 0%, rgba(8,9,13,0.85) 70%, transparent 100%); backdrop-filter: blur(12px); flex-wrap: wrap; }
        .ctrl-bar .logo { font-family: 'DM Sans', sans-serif; font-weight: 700; font-size: 20px; color: #00ff9f; letter-spacing: 4px; text-transform: uppercase; margin-right: 12px; white-space: nowrap; user-select: none; }
        .ctrl-bar .logo span { color: #1e2028; font-weight: 400; }
        .ctrl-bar input, .ctrl-bar select { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); color: #9a9eaa; font-family: 'JetBrains Mono', monospace; font-size: 15px; padding: 8px 12px; border-radius: 4px; outline: none; transition: border-color 0.2s; }
        .ctrl-bar input:focus, .ctrl-bar select:focus { border-color: rgba(0,255,159,0.4); }
        .ctrl-bar input::placeholder { color: #2a2e3a; }
        .ctrl-bar select option { background: #0e0f14; color: #9a9eaa; }
        .ctrl-btn { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.07); color: #5a5e6a; font-family: 'JetBrains Mono', monospace; font-size: 15px; padding: 8px 15px; border-radius: 4px; cursor: pointer; transition: all 0.15s; white-space: nowrap; }
        .ctrl-btn:hover { background: rgba(0,255,159,0.06); border-color: rgba(0,255,159,0.3); color: #00ff9f; }
        .ctrl-btn.active { background: rgba(0,255,159,0.1); border-color: rgba(0,255,159,0.4); color: #00ff9f; }
        .stat { font-size: 14px; color: #2a2e3a; letter-spacing: 2px; text-transform: uppercase; white-space: nowrap; }
        .stat b { color: #00ff9f; font-weight: 500; }

        .detail-panel { position: absolute; top: 60px; right: 0; bottom: 0; width: 560px; max-width: 90vw; background: rgba(8,9,13,0.97); backdrop-filter: blur(16px); border-left: 1px solid rgba(255,255,255,0.06); z-index: 20; overflow-y: auto; padding: 36px 32px; animation: slideIn 0.2s ease-out; }
        @keyframes slideIn { from { transform: translateX(40px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
        .detail-panel h2 { font-family: 'DM Sans', sans-serif; font-size: 22px; font-weight: 600; color: #e2e4ea; line-height: 1.5; margin-bottom: 20px; }
        .detail-meta { font-size: 15px; color: #4a4e5a; margin-bottom: 8px; line-height: 1.6; }
        .detail-meta b { color: #6a6e7a; font-weight: 500; }
        .detail-tags { display: flex; flex-wrap: wrap; gap: 6px; margin: 18px 0; }
        .detail-tag { font-size: 12px; padding: 5px 10px; border-radius: 3px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06); color: #5a5e6a; letter-spacing: 0.5px; text-transform: uppercase; }
        .detail-tag.topic { border-color: var(--topic-color, #00ff9f); color: var(--topic-color, #00ff9f); background: rgba(0,255,159,0.05); }
        .detail-abstract { font-family: 'DM Sans', sans-serif; font-size: 16px; line-height: 1.8; color: #6a6e7a; margin-top: 20px; white-space: pre-wrap; border-top: 1px solid rgba(255,255,255,0.04); padding-top: 20px; }
        .fav-btn { display: inline-flex; align-items: center; gap: 8px; background: rgba(255,217,61,0.05); border: 1px solid rgba(255,217,61,0.15); color: #ffd93d; font-family: 'JetBrains Mono', monospace; font-size: 15px; padding: 8px 18px; border-radius: 4px; cursor: pointer; transition: all 0.15s; margin-top: 16px; }
        .fav-btn:hover { background: rgba(255,217,61,0.1); }
        .fav-btn.is-fav { background: rgba(255,217,61,0.12); border-color: rgba(255,217,61,0.3); }
        .close-btn { position: absolute; top: 24px; right: 24px; background: none; border: 1px solid rgba(255,255,255,0.06); color: #3a3e4a; width: 36px; height: 36px; display: flex; align-items: center; justify-content: center; border-radius: 4px; cursor: pointer; font-size: 20px; transition: all 0.15s; }
        .close-btn:hover { border-color: #ff6b6b; color: #ff6b6b; }

        .tooltip { position: absolute; z-index: 30; background: rgba(10,11,16,0.97); border: 1px solid rgba(255,255,255,0.08); backdrop-filter: blur(12px); padding: 14px 18px; border-radius: 6px; pointer-events: none; max-width: 460px; animation: tooltipIn 0.12s ease-out; }
        @keyframes tooltipIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
        .tooltip h4 { font-family: 'DM Sans', sans-serif; font-size: 16px; font-weight: 500; color: #d8dae0; margin-bottom: 6px; line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
        .tooltip p { font-size: 14px; color: #4a4e5a; line-height: 1.4; }

        .legend-panel { position: absolute; bottom: 20px; left: 20px; z-index: 15; background: rgba(8,9,13,0.95); border: 1px solid rgba(255,255,255,0.06); backdrop-filter: blur(12px); padding: 18px 24px; border-radius: 6px; max-height: 600px; overflow-y: auto; animation: tooltipIn 0.2s ease-out; min-width: 380px; }
        .legend-panel h5 { font-size: 12px; color: #2a2e3a; letter-spacing: 3px; text-transform: uppercase; margin-bottom: 14px; }
        .legend-item { display: flex; align-items: center; gap: 10px; font-size: 14px; color: #4a4e5a; margin-bottom: 6px; cursor: pointer; transition: color 0.15s; }
        .legend-item:hover { color: #c8ccd4; }
        .legend-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
        .legend-count { color: #2a2e3a; margin-left: auto; font-size: 12px; }

        .table-panel { position: absolute; bottom: 0; left: 0; right: 0; z-index: 25; background: rgba(8,9,13,0.98); border-top: 1px solid rgba(255,255,255,0.06); backdrop-filter: blur(16px); display: flex; flex-direction: column; animation: slideUp 0.2s ease-out; }
        @keyframes slideUp { from { transform: translateY(100%); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
        .table-resize-handle { height: 6px; cursor: ns-resize; background: transparent; flex-shrink: 0; display: flex; align-items: center; justify-content: center; }
        .table-resize-handle::after { content: ''; width: 40px; height: 3px; border-radius: 2px; background: rgba(255,255,255,0.1); }
        .table-resize-handle:hover::after { background: rgba(0,255,159,0.3); }
        .table-header { display: flex; align-items: center; justify-content: space-between; padding: 10px 20px; border-bottom: 1px solid rgba(255,255,255,0.04); flex-shrink: 0; }
        .table-header span { font-size: 13px; color: #3a3e4a; letter-spacing: 2px; text-transform: uppercase; }
        .table-body { overflow-y: auto; flex: 1; }
        .table-body table { width: 100%; border-collapse: collapse; font-size: 13px; }
        .table-body th { position: sticky; top: 0; background: #0e0f14; color: #4a4e5a; font-weight: 500; text-align: left; padding: 10px 14px; border-bottom: 1px solid rgba(255,255,255,0.06); font-size: 12px; letter-spacing: 1px; text-transform: uppercase; white-space: nowrap; }
        .table-body td { padding: 10px 14px; border-bottom: 1px solid rgba(255,255,255,0.03); color: #7a7e8a; max-width: 400px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .table-body tr { cursor: pointer; transition: background 0.1s; }
        .table-body tr:hover { background: rgba(0,255,159,0.03); }
        .table-body tr:hover td { color: #c8ccd4; }
        .table-pager { display: flex; align-items: center; gap: 10px; }
        .table-pager button { background: none; border: 1px solid rgba(255,255,255,0.06); color: #5a5e6a; font-family: 'JetBrains Mono', monospace; font-size: 13px; padding: 4px 12px; border-radius: 3px; cursor: pointer; }
        .table-pager button:hover { border-color: rgba(0,255,159,0.3); color: #00ff9f; }
        .table-pager button:disabled { opacity: 0.3; cursor: default; }
        .table-pager span { font-size: 13px; color: #3a3e4a; }

        .zoom-info { position: absolute; bottom: 20px; right: 20px; z-index: 15; font-size: 12px; color: #1a1e2a; letter-spacing: 2px; user-select: none; }
      `}</style>

      {/* Control Bar */}
      <div className="ctrl-bar">
        <div className="logo">AACR<span>.</span>2026</div>
        <input type="text" placeholder="Search titles, authors, IDs..." style={{ width: 270 }} value={searchTerm} onChange={(e) => { setSearchTerm(e.target.value); setTablePage(0); }} />
        <select value={filterTopic} onChange={(e) => { setFilterTopic(e.target.value); setTablePage(0); }} style={{ maxWidth: 360 }}>
          <option value="All">All Topics</option>
          {clusterTopics.map(({ topic, count }) => <option key={topic} value={topic}>{topic} ({count})</option>)}
        </select>
        <select value={filterSession} onChange={(e) => { setFilterSession(e.target.value); setTablePage(0); }} style={{ maxWidth: 330 }}>
          <option value="All">All Sessions</option>
          {sessions.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <button className={`ctrl-btn ${showFavoritesOnly ? "active" : ""}`} onClick={() => setShowFavoritesOnly(!showFavoritesOnly)}>★ {favorites.size}</button>
        <button className="ctrl-btn" onClick={() => setShowLegend(!showLegend)}>Legend</button>
        <button className={`ctrl-btn ${showTable ? "active" : ""}`} onClick={() => { setShowTable(!showTable); setTablePage(0); }}>Table</button>
        <button className="ctrl-btn" onClick={() => exportCSV(false)}>↓ All</button>
        <button className="ctrl-btn" onClick={() => exportCSV(true)}>↓ Favs</button>
        <button className="ctrl-btn" onClick={() => { smoothSetCamera({ x: 0, y: 0, zoom: 1 }); }}>Reset</button>
        <span className="stat"><b>{filteredIndices.length}</b> / {abstracts.length}</span>
      </div>

      {/* Canvas */}
      <div ref={containerRef} style={{ position: "absolute", inset: 0, cursor: dragRef.current.dragging ? "grabbing" : "crosshair" }}>
        <canvas ref={canvasRef} style={{ width: dimensions.w, height: dimensions.h, display: "block" }}
          onMouseDown={handleMouseDown} onMouseMove={handleMouseMove} onMouseUp={handleMouseUp}
          onMouseLeave={() => { handleMouseUp(); setHoveredId(null); setTooltipData(null); }} onClick={handleClick} />
      </div>

      {/* Tooltip */}
      {tooltipData && !selected && (
        <div className="tooltip" style={{ left: Math.min(tooltipData.x + 16, dimensions.w - 480), top: tooltipData.y + 16 }}>
          <h4>{tooltipData.abstract.title}</h4>
          <p>{tooltipData.abstract.authors.slice(0, 3).join(", ")}{tooltipData.abstract.authors.length > 3 ? " et al." : ""}</p>
          <p style={{ color: topicColors[tooltipData.abstract.clusterTopic], marginTop: 2 }}>{tooltipData.abstract.clusterTopic} · #{tooltipData.abstract.posterNumber}</p>
        </div>
      )}

      {/* Legend */}
      {showLegend && (
        <div className="legend-panel">
          <h5>Topic Clusters</h5>
          {clusterTopics.map(({ topic, count }) => (
            <div key={topic} className="legend-item" onClick={() => setFilterTopic(filterTopic === topic ? "All" : topic)}>
              <div className="legend-dot" style={{ background: topicColors[topic] }} />
              <span style={filterTopic === topic ? { color: topicColors[topic] } : {}}>{topic}</span>
              <span className="legend-count">{count}</span>
            </div>
          ))}
        </div>
      )}

      {/* Table Browser */}
      {showTable && (
        <div className="table-panel" style={{ height: tableHeight }}>
          <div className="table-resize-handle" onMouseDown={handleTableResizeStart} />
          <div className="table-header">
            <span>Abstracts ({tableData.length})</span>
            <div className="table-pager">
              <button disabled={tablePage === 0} onClick={() => setTablePage((p) => p - 1)}>Prev</button>
              <span>{tablePage + 1} / {totalTablePages}</span>
              <button disabled={tablePage >= totalTablePages - 1} onClick={() => setTablePage((p) => p + 1)}>Next</button>
              <button className="close-btn" style={{ position: "static", width: 28, height: 28, fontSize: 16 }} onClick={() => setShowTable(false)}>×</button>
            </div>
          </div>
          <div className="table-body">
            <table>
              <thead><tr><th>ID</th><th>Title</th><th>Presenter</th><th>Session</th><th>Topic</th><th>Fav</th></tr></thead>
              <tbody>
                {tablePageData.map((a) => (
                  <tr key={a.id + a.internalId} onClick={() => { const idx = abstracts.indexOf(a); setSelectedId(idx >= 0 ? idx : null); }}>
                    <td style={{ color: "#3a3e4a", whiteSpace: "nowrap" }}>{a.id}</td>
                    <td style={{ color: "#9a9eaa" }}>{a.title}</td>
                    <td>{a.presenter}</td>
                    <td style={{ maxWidth: 200 }}>{a.session}</td>
                    <td style={{ color: topicColors[a.clusterTopic], maxWidth: 200 }}>{a.clusterTopic}</td>
                    <td style={{ textAlign: "center", cursor: "pointer" }} onClick={(e) => { e.stopPropagation(); toggleFavorite(a.id); }}>
                      {favorites.has(a.id) ? <span style={{ color: "#ffd93d" }}>★</span> : <span style={{ color: "#2a2e3a" }}>☆</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Detail Panel */}
      {selected && (
        <div className="detail-panel">
          <button className="close-btn" onClick={() => setSelectedId(null)}>×</button>
          <div style={{ fontSize: 12, color: "#2a2e3a", letterSpacing: 3, marginBottom: 14 }}>#{selected.id} · POSTER {selected.posterNumber} · {selected.start}</div>
          <h2>{selected.title}</h2>
          <div className="detail-meta"><b>Presenter:</b> {selected.presenter}</div>
          <div className="detail-meta"><b>Authors:</b> {selected.authors.join(", ")}</div>
          <div className="detail-meta"><b>Institution:</b> {selected.institution}</div>
          <div className="detail-meta"><b>Session:</b> {selected.session}</div>
          <div className="detail-tags">
            <span className="detail-tag topic" style={{ "--topic-color": topicColors[selected.clusterTopic] }}>{selected.clusterTopic}</span>
          </div>
          <button className={`fav-btn ${favorites.has(selected.id) ? "is-fav" : ""}`} onClick={() => toggleFavorite(selected.id)}>
            {favorites.has(selected.id) ? "★ Remove from Favorites" : "☆ Add to Favorites"}
          </button>
          {selected.abstract && <div className="detail-abstract">{selected.abstract}</div>}
        </div>
      )}

      {/* Zoom Info */}
      {!showTable && <div className="zoom-info">{(camera.zoom * 100).toFixed(0)}% · SCROLL ZOOM · DRAG PAN</div>}
    </div>
  );
}
