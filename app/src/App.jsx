import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";

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

/* ── 3D Point Cloud (rendered inside R3F Canvas) ── */
function PointCloud({
  abstracts, embeddings, filteredSet, searchSimilarity,
  clusterColors, hoveredId, selectedId, onHover, onSelect, onTooltipPos,
}) {
  const pointsRef = useRef();
  const geomRef = useRef();
  const { camera, size, raycaster } = useThree();
  const N = embeddings.length;

  // Set raycaster threshold for small points
  useEffect(() => {
    if (!raycaster.params.Points) raycaster.params.Points = {};
    raycaster.params.Points.threshold = 0.015;
  }, [raycaster]);

  // Position buffer — built once
  const positions = useMemo(() => {
    const arr = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      arr[i * 3]     = embeddings[i].x - 0.5;
      arr[i * 3 + 1] = embeddings[i].y - 0.5;
      arr[i * 3 + 2] = (embeddings[i].z ?? 0) - 0.5;
    }
    return arr;
  }, [embeddings, N]);

  // Color buffer — recomputed when filters/search change
  const colors = useMemo(() => {
    const arr = new Float32Array(N * 3);
    const c = new THREE.Color();
    for (let i = 0; i < N; i++) {
      const a = abstracts[i];
      let hex;
      if (!filteredSet.has(i)) {
        hex = "#1a1e28";
      } else if (searchSimilarity) {
        hex = similarityColor(searchSimilarity[i]);
      } else {
        hex = clusterColors[a.cluster] || "#ffffff";
      }
      c.set(hex);
      arr[i * 3]     = c.r;
      arr[i * 3 + 1] = c.g;
      arr[i * 3 + 2] = c.b;
    }
    return arr;
  }, [abstracts, N, filteredSet, searchSimilarity, clusterColors]);

  // Apply geometry imperatively for reliable buffer updates
  useEffect(() => {
    if (!geomRef.current) return;
    geomRef.current.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geomRef.current.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geomRef.current.computeBoundingSphere();
  }, [positions, colors]);

  // Update only colors when they change (positions are stable)
  useEffect(() => {
    if (!geomRef.current || !geomRef.current.attributes.color) return;
    geomRef.current.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  }, [colors]);

  const handlePointerMove = useCallback((e) => {
    e.stopPropagation();
    const i = e.index;
    if (i == null) return;
    onHover(i);
    const emb = embeddings[i];
    if (emb) {
      const vec = new THREE.Vector3(emb.x - 0.5, emb.y - 0.5, (emb.z ?? 0) - 0.5);
      vec.project(camera);
      const sx = (vec.x * 0.5 + 0.5) * size.width;
      const sy = (-vec.y * 0.5 + 0.5) * size.height;
      onTooltipPos({ sx, sy, abstract: abstracts[i] });
    }
  }, [camera, size, embeddings, abstracts, onHover, onTooltipPos]);

  const handlePointerOut = useCallback(() => {
    onHover(null);
    onTooltipPos(null);
  }, [onHover, onTooltipPos]);

  const handleClick = useCallback((e) => {
    e.stopPropagation();
    onSelect(e.index ?? null);
  }, [onSelect]);

  const hovPos = (hoveredId !== null && embeddings[hoveredId])
    ? [embeddings[hoveredId].x - 0.5, embeddings[hoveredId].y - 0.5, (embeddings[hoveredId].z ?? 0) - 0.5]
    : null;
  const selPos = (selectedId !== null && embeddings[selectedId])
    ? [embeddings[selectedId].x - 0.5, embeddings[selectedId].y - 0.5, (embeddings[selectedId].z ?? 0) - 0.5]
    : null;

  return (
    <>
      <points
        ref={pointsRef}
        onPointerMove={handlePointerMove}
        onPointerOut={handlePointerOut}
        onClick={handleClick}
      >
        <bufferGeometry ref={geomRef} />
        <pointsMaterial vertexColors size={0.012} sizeAttenuation transparent opacity={0.9} depthWrite={false} />
      </points>

      {hovPos && (
        <mesh position={hovPos}>
          <sphereGeometry args={[0.018, 12, 12]} />
          <meshBasicMaterial
            color={clusterColors[abstracts[hoveredId]?.cluster] || "#ffffff"}
            transparent opacity={0.6}
          />
        </mesh>
      )}

      {selPos && (
        <mesh position={selPos}>
          <sphereGeometry args={[0.026, 16, 16]} />
          <meshBasicMaterial
            color={clusterColors[abstracts[selectedId]?.cluster] || "#ffffff"}
            transparent opacity={0.85}
          />
        </mesh>
      )}
    </>
  );
}

/* ── Main App ── */
export default function AACRExplorer() {
  const [abstracts, setAbstracts] = useState([]);
  const [embeddings, setEmbeddings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingStatus, setLoadingStatus] = useState("Fetching abstracts...");

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

  const orbitControlsRef = useRef(null);
  const handleReset = useCallback(() => orbitControlsRef.current?.reset(), []);

  // Load precomputed data
  useEffect(() => {
    (async () => {
      try {
        const resp = await fetch(import.meta.env.BASE_URL + "aacr_data.json");
        const data = await resp.json();
        setLoadingStatus(`Loading ${data.length} abstracts...`);
        const emb = data.map((d) => ({ x: d.x, y: d.y, z: d.z ?? 0.5 }));
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

  // Search similarity: 3D centroid distance
  const searchSimilarity = useMemo(() => {
    if (!searchTerm || searchTerm.length < 2 || embeddings.length === 0) return null;
    const term = searchTerm.toLowerCase();
    const matches = [];
    abstracts.forEach((a, i) => {
      if (a.title.toLowerCase().includes(term) || a.authors.join(" ").toLowerCase().includes(term) || a.id.toLowerCase().includes(term) || a.presenter.toLowerCase().includes(term))
        matches.push(i);
    });
    if (matches.length === 0) return null;
    let cx = 0, cy = 0, cz = 0;
    matches.forEach((i) => { cx += embeddings[i].x; cy += embeddings[i].y; cz += embeddings[i].z; });
    cx /= matches.length; cy /= matches.length; cz /= matches.length;
    const dists = embeddings.map((e) => Math.hypot(e.x - cx, e.y - cy, e.z - cz));
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

  // Table resize drag
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
        <button className="ctrl-btn" onClick={handleReset}>Reset</button>
        <span className="stat"><b>{filteredIndices.length}</b> / {abstracts.length}</span>
      </div>

      {/* 3D Canvas */}
      <Canvas
        camera={{ position: [0, 0, 2], fov: 60, near: 0.01, far: 100 }}
        style={{ position: "absolute", inset: 0 }}
        gl={{ antialias: true }}
      >
        <color attach="background" args={["#08090d"]} />
        <PointCloud
          abstracts={abstracts}
          embeddings={embeddings}
          filteredSet={filteredSet}
          searchSimilarity={searchSimilarity}
          clusterColors={clusterColors}
          hoveredId={hoveredId}
          selectedId={selectedId}
          onHover={setHoveredId}
          onSelect={setSelectedId}
          onTooltipPos={setTooltipData}
        />
        <OrbitControls
          ref={orbitControlsRef}
          enableDamping
          dampingFactor={0.05}
          minDistance={0.3}
          maxDistance={6}
        />
      </Canvas>

      {/* Tooltip */}
      {tooltipData && !selected && (
        <div className="tooltip" style={{ left: Math.min(tooltipData.sx + 16, window.innerWidth - 480), top: Math.min(tooltipData.sy + 16, window.innerHeight - 120) }}>
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

      {/* Controls hint */}
      {!showTable && <div className="zoom-info">DRAG ROTATE · SCROLL ZOOM · RIGHT-DRAG PAN</div>}
    </div>
  );
}
