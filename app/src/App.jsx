import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Canvas, useThree, useFrame, extend } from "@react-three/fiber";
import { OrbitControls, GizmoHelper, GizmoViewport, shaderMaterial } from "@react-three/drei";
import * as THREE from "three";

const PICK_RADIUS_PX = 30;
const ZOOM_STOP_COUNT = 22;

/* ── Color palette (40 clusters) — vibrant, dark-theme optimized ── */
const PALETTE = [
  "#ff4757", "#ff6b81", "#ff7f50", "#ff9f43",
  "#ffd32a", "#ffdd59", "#7bed9f", "#adff2f",
  "#2ed573", "#1dd1a1", "#00d2d3", "#48dbfb",
  "#54a0ff", "#1e90ff", "#5352ed", "#3742fa",
  "#a29bfe", "#6c5ce7", "#8854d0", "#be2edd",
  "#e84393", "#fd79a8", "#f368e0", "#ff9ff3",
  "#e17055", "#fdcb6e", "#f9ca24", "#badc58",
  "#26de81", "#01abc7", "#0652dd", "#00b894",
  "#ff6348", "#eccc68", "#45aaf2", "#ff4081",
  "#2bcbba", "#ee5a24", "#f8b739", "#778beb",
];

const FAVORITE_IDS_KEY = "aacr-favorite-ids";
const LISTS_STORAGE_KEY = "aacr-favorite-lists";
const LISTS_LEGACY_KEY = "aacr-favorites";
const FAVORITE_POINT_COLOR = "#ffd93d";
const ZOOM_MIN = 0.55;
const ZOOM_MAX = 2;

function parseStartMs(s) {
  if (!s || typeof s !== "string") return 0;
  const t = Date.parse(s);
  return Number.isNaN(t) ? 0 : t;
}

function formatAgendaDate(ms) {
  if (!ms) return "Unknown date";
  return new Date(ms).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}

function loadFavoriteIds() {
  try {
    const direct = localStorage.getItem(FAVORITE_IDS_KEY);
    if (direct) {
      const ids = JSON.parse(direct);
      return Array.isArray(ids) ? ids.map(String) : [];
    }
    const stored = localStorage.getItem(LISTS_STORAGE_KEY);
    if (stored) {
      const p = JSON.parse(stored);
      const first = p?.lists?.[0];
      if (first?.ids && Array.isArray(first.ids)) return first.ids.map(String);
    }
    const legacy = localStorage.getItem(LISTS_LEGACY_KEY);
    if (legacy) {
      const ids = JSON.parse(legacy);
      return Array.isArray(ids) ? ids.map(String) : [];
    }
  } catch { /* ignore */ }
  return [];
}

function normalizeAffiliationRunOns(raw) {
  if (!raw) return "";
  return raw.replace(/([a-z])(\d)(\d)([A-Z])/g, "$1$2, $3$4");
}

function parseInstitutionBlock(raw) {
  const s = normalizeAffiliationRunOns(raw || "").trim();
  if (!s) return { authorParts: [], affiliationLines: [] };

  let authorChunk = s;
  let affilChunk = "";
  // Boundary: comma then optional space then "1Yale…" / "2MIT…" (affiliation index + name).
  // Data often has ", 1City" not ",1City" — the old pattern missed the split and left the first affil on the author line.
  const commaDigitCap = s.match(/^(.*?),\s*(\d+[A-Z].*)$/s);
  if (commaDigitCap) {
    authorChunk = commaDigitCap[1].trim();
    affilChunk = commaDigitCap[2].trim();
  } else {
    const m = s.match(/^(.*?)(\d+[A-Z][\s\S]*)$/);
    if (m && m[1].length > 0 && m[1].length < s.length - 5) {
      authorChunk = m[1].trim().replace(/,\s*$/, "");
      affilChunk = m[2].trim();
    }
  }

  const authorParts = [];
  const authorSegs = authorChunk.split(",").map((x) => x.trim()).filter(Boolean);
  for (const seg of authorSegs) {
    const sup = seg.match(/^(.+?)(\d+)$/);
    if (sup) authorParts.push({ text: sup[1].trim(), sup: sup[2] });
    else authorParts.push({ text: seg, sup: null });
  }

  const affiliationLines = [];
  if (affilChunk) {
    const parts = affilChunk.split(/(?=\d+[A-Z])/);
    for (const p of parts) {
      const t = p.trim();
      if (!t) continue;
      const m = t.match(/^(\d+)(.+)$/);
      if (m) affiliationLines.push({ num: m[1], text: m[2].trim() });
      else affiliationLines.push({ num: null, text: t });
    }
  }

  return { authorParts, affiliationLines };
}

function AffiliationView({ institution, authors }) {
  const { authorParts, affiliationLines } = parseInstitutionBlock(institution);
  const hasParsedAffil = affiliationLines.length > 0;
  const hasAuthorSup = authorParts.some((p) => p.sup);
  if (!hasParsedAffil && !hasAuthorSup) {
    return (
      <>
        <div className="detail-meta"><b>Authors:</b> {(authors || []).join(", ")}</div>
        {institution ? <div className="detail-meta"><b>Institution:</b> {institution}</div> : null}
      </>
    );
  }
  return (
    <>
      <div className="detail-meta">
        <b>Authors:</b>{" "}
        {authorParts.map((p, i) => (
          <span key={i}>
            {i > 0 ? ", " : ""}
            {p.text}
            {p.sup ? <sup>{p.sup}</sup> : null}
          </span>
        ))}
      </div>
      {affiliationLines.length > 0 ? (
        <div className="detail-meta" style={{ marginTop: 10 }}>
          <b>Affiliations</b>
          {affiliationLines.map((line, i) => (
            <div key={i} style={{ marginTop: 6, lineHeight: 1.45 }}>
              {line.num ? <><sup>{line.num}</sup> {line.text}</> : line.text}
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}

const SIDEBAR_STORAGE_KEY = "aacr-sidebar-open";
const SIDEBAR_WIDTH_PX = 400;
const TOP_BAR_PX = 52;
const FILTER_LIST_CAP = 120;

function topicLabelColor(topic) {
  const t = topic || "Unknown";
  let h = 0;
  for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(h) % PALETTE.length];
}

function abstractMatchesSearch(a, term) {
  if (!term) return true;
  const t = term.toLowerCase();
  const parts = [
    a.title,
    (a.authors || []).join(" "),
    String(a.id),
    a.presenter || "",
    a.clusterTopic || "",
    a.session || "",
    a.institution || "",
    ...(Array.isArray(a.topics) ? a.topics : []),
    ...(Array.isArray(a.keywords) ? a.keywords : []),
  ].map((x) => String(x).toLowerCase());
  return parts.some((p) => p.includes(t));
}

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

const POINT_SPRITE_VERT = `
  varying vec3 vColor;
  varying float vDistance;
  uniform float uRadius;

  void main() {
    vColor = color;
    float distanceFactor = pow(max(0.0, uRadius - distance(position, vec3(0.0))), 1.5);
    float size = distanceFactor * 10.0 + 10.0;
    vDistance = distanceFactor;

    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;

    gl_PointSize = size;
    gl_PointSize *= (1.0 / max(-mvPosition.z, 1e-4));
  }
`;

const POINT_SPRITE_FRAG = `
  varying vec3 vColor;
  varying float vDistance;
  uniform vec3 uWarmTint;
  uniform float uIntensity;

  void main() {
    vec3 color = vColor;
    float r = distance(gl_PointCoord, vec2(0.5)) * 2.0;
    float strength = pow(max(1.0 - smoothstep(0.48, 1.0, r), 0.0), 1.18);

    float warmAmt = clamp(vDistance * 0.042, 0.0, 0.11);
    color = mix(color, uWarmTint, warmAmt);
    color *= uIntensity;
    // Additive (SrcAlpha, One): one falloff via rgb; alpha 1 avoids strength^2 blowout
    gl_FragColor = vec4(color * strength, 1.0);
  }
`;

const PointSpriteMaterial = shaderMaterial(
  {
    uRadius: 1.5,
    uWarmTint: new THREE.Vector3(0.88, 0.78, 0.72),
    uIntensity: 0.62,
  },
  POINT_SPRITE_VERT,
  POINT_SPRITE_FRAG,
  (m) => {
    m.glslVersion = THREE.GLSL1;
    m.transparent = true;
    m.depthWrite = false;
    m.blending = THREE.AdditiveBlending;
    m.vertexColors = true;
  },
);
extend({ PointSpriteMaterial });

function pickNearestScreenIndex(clientX, clientY, rect, camera, positions, indices, v) {
  const px = clientX - rect.left;
  const py = clientY - rect.top;
  let best = null;
  let bestD = Infinity;
  for (let k = 0; k < indices.length; k++) {
    const i = indices[k];
    v.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
    v.project(camera);
    if (v.z < -1 || v.z > 1) continue;
    const sx = (v.x * 0.5 + 0.5) * rect.width;
    const sy = (-v.y * 0.5 + 0.5) * rect.height;
    const d = Math.hypot(px - sx, py - sy);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  if (best !== null && bestD <= PICK_RADIUS_PX) return best;
  return null;
}

/* ── Point Cloud ── */
function PointCloud({
  abstracts, embeddings, filteredSet, filteredIndices, searchSimilarity,
  clusterColors, topicColors, topicFilterSelected, selectedId, onHover, onSelect, onTooltipPos,
  listVisuals,
}) {
  const geomRef = useRef();
  const { camera, gl } = useThree();
  const N = embeddings.length;
  const vProj = useRef(new THREE.Vector3());
  const pickRaf = useRef(0);
  const pendingPointer = useRef(null);

  const positions = useMemo(() => {
    const arr = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      arr[i * 3]     = embeddings[i].x - 0.5;
      arr[i * 3 + 1] = embeddings[i].y - 0.5;
      arr[i * 3 + 2] = (embeddings[i].z ?? 0) - 0.5;
    }
    return arr;
  }, [embeddings, N]);

  const baseColors = useMemo(() => {
    const arr = new Float32Array(N * 3);
    const c = new THREE.Color();
    const accent = new THREE.Color();
    const topicFilterOn = topicFilterSelected.size > 0;
    for (let i = 0; i < N; i++) {
      const topic = abstracts[i].clusterTopic || "Unknown";
      let hex = !filteredSet.has(i) ? "#252a35"
        : searchSimilarity ? similarityColor(searchSimilarity[i])
        : topicFilterOn
          ? (topicColors[topic] || "#c8d8ff")
          : (clusterColors[abstracts[i].cluster] || "#c8d8ff");
      if (filteredSet.has(i) && !searchSimilarity && listVisuals) {
        const id = abstracts[i].id;
        c.set(hex);
        if (listVisuals.activeIds.has(id)) {
          accent.set(listVisuals.idToColor.get(id) || "#ffd93d");
          c.lerp(accent, 0.52);
          hex = `#${c.getHexString()}`;
        } else if (listVisuals.tintOthers && listVisuals.idToColor.has(id)) {
          accent.set(listVisuals.idToColor.get(id));
          c.lerp(accent, 0.32);
          hex = `#${c.getHexString()}`;
        }
      }
      c.set(hex);
      if (selectedId !== null && filteredSet.has(i) && i !== selectedId) {
        c.multiplyScalar(0.34);
      }
      arr[i * 3]     = c.r;
      arr[i * 3 + 1] = c.g;
      arr[i * 3 + 2] = c.b;
    }
    return arr;
  }, [abstracts, N, filteredSet, searchSimilarity, clusterColors, topicColors, topicFilterSelected, listVisuals, selectedId]);

  useEffect(() => {
    if (!geomRef.current || N === 0) return;
    geomRef.current.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const colAttr = new THREE.BufferAttribute(baseColors.slice(), 3);
    colAttr.setUsage(THREE.DynamicDrawUsage);
    geomRef.current.setAttribute("color", colAttr);
    geomRef.current.computeBoundingSphere();
  }, [positions, baseColors, N]);

  const applyHover = useCallback((clientX, clientY) => {
    const rect = gl.domElement.getBoundingClientRect();
    const i = pickNearestScreenIndex(clientX, clientY, rect, camera, positions, filteredIndices, vProj.current);
    if (i === null) {
      onHover(null);
      onTooltipPos(null);
      return;
    }
    onHover(i);
    const emb = embeddings[i];
    if (emb) {
      vProj.current.set(emb.x - 0.5, emb.y - 0.5, (emb.z ?? 0) - 0.5);
      vProj.current.project(camera);
      onTooltipPos({
        sx: (vProj.current.x * 0.5 + 0.5) * rect.width,
        sy: (-vProj.current.y * 0.5 + 0.5) * rect.height,
        abstract: abstracts[i],
      });
    }
  }, [gl, camera, positions, filteredIndices, embeddings, abstracts, onHover, onTooltipPos]);

  useEffect(() => {
    const el = gl.domElement;
    const flushPick = () => {
      pickRaf.current = 0;
      const p = pendingPointer.current;
      if (p) applyHover(p.x, p.y);
    };
    const schedulePick = (e) => {
      pendingPointer.current = { x: e.clientX, y: e.clientY };
      if (!pickRaf.current) pickRaf.current = requestAnimationFrame(flushPick);
    };
    const onLeave = () => {
      pendingPointer.current = null;
      onHover(null);
      onTooltipPos(null);
    };
    const onClick = (e) => {
      const rect = el.getBoundingClientRect();
      const i = pickNearestScreenIndex(e.clientX, e.clientY, rect, camera, positions, filteredIndices, vProj.current);
      onSelect(i);
    };
    el.addEventListener("pointermove", schedulePick);
    el.addEventListener("pointerleave", onLeave);
    el.addEventListener("click", onClick);
    return () => {
      el.removeEventListener("pointermove", schedulePick);
      el.removeEventListener("pointerleave", onLeave);
      el.removeEventListener("click", onClick);
      if (pickRaf.current) cancelAnimationFrame(pickRaf.current);
    };
  }, [gl, camera, positions, filteredIndices, applyHover, onHover, onTooltipPos, onSelect]);

  const glowTexture = useMemo(() => {
    const sz = 32;
    const canvas = document.createElement("canvas");
    canvas.width = sz; canvas.height = sz;
    const ctx = canvas.getContext("2d");
    const grad = ctx.createRadialGradient(sz/2, sz/2, 0, sz/2, sz/2, sz/2);
    grad.addColorStop(0,   "rgba(255,255,255,1)");
    grad.addColorStop(0.3, "rgba(255,255,255,0.6)");
    grad.addColorStop(1,   "rgba(255,255,255,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, sz, sz);
    const tex = new THREE.CanvasTexture(canvas);
    tex.generateMipmaps = false;
    tex.minFilter = THREE.LinearFilter;
    return tex;
  }, []);

  const glowGeomRef = useRef();
  useEffect(() => {
    if (!glowGeomRef.current) return;
    const selEmb = selectedId !== null ? embeddings[selectedId] : null;
    if (selEmb) {
      const pos = new Float32Array([selEmb.x - 0.5, selEmb.y - 0.5, (selEmb.z ?? 0) - 0.5]);
      glowGeomRef.current.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      glowGeomRef.current.setDrawRange(0, 1);
      glowGeomRef.current.computeBoundingSphere();
    } else {
      glowGeomRef.current.setDrawRange(0, 0);
    }
  }, [selectedId, embeddings]);

  return (
    <>
      <points raycast={() => null}>
        <bufferGeometry ref={geomRef} />
        <pointSpriteMaterial />
      </points>

      {/* Selection glow */}
      <points frustumCulled={false} raycast={() => null}>
        <bufferGeometry ref={glowGeomRef} />
        <pointsMaterial
          map={glowTexture}
          color="#c8d8ff"
          size={0.042}
          sizeAttenuation
          opacity={0.45}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          transparent
        />
      </points>
    </>
  );
}




function zoomStopDistances(minDist, maxDist, n) {
  if (n < 2) return [minDist, maxDist];
  const ratio = maxDist / minDist;
  return Array.from({ length: n }, (_, i) => minDist * Math.pow(ratio, i / (n - 1)));
}

function nearestZoomStopIndex(length, stops) {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < stops.length; i++) {
    const d = Math.abs(stops[i] - length);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/* ── Smooth zoom: discrete log-spaced stops + eased lerp ── */
function SmoothZoom({ minDist, maxDist }) {
  const { camera, gl } = useThree();
  const targetRef = useRef(null);
  const stops = useMemo(
    () => zoomStopDistances(minDist, maxDist, ZOOM_STOP_COUNT),
    [minDist, maxDist],
  );

  useEffect(() => {
    const el = gl.domElement;
    const onWheel = (e) => {
      e.preventDefault();
      const len = targetRef.current ?? camera.position.length();
      const i = nearestZoomStopIndex(len, stops);
      const next = e.deltaY > 0 ? Math.min(stops.length - 1, i + 1) : Math.max(0, i - 1);
      targetRef.current = stops[next];
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [gl, camera, stops]);

  useFrame(() => {
    if (targetRef.current === null) return;
    const cur = camera.position.length();
    const next = cur + (targetRef.current - cur) * 0.075;
    if (Math.abs(next - targetRef.current) < 0.001) {
      camera.position.setLength(targetRef.current);
      targetRef.current = null;
    } else {
      camera.position.setLength(next);
    }
  });

  return null;
}

/* ── Main App ── */
export default function AACRExplorer() {
  const [abstracts, setAbstracts] = useState([]);
  const [embeddings, setEmbeddings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingStatus, setLoadingStatus] = useState("Fetching abstracts...");

  const [hoveredId, setHoveredId] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [favoriteIds, setFavoriteIds] = useState(() => loadFavoriteIds());
  const [searchTerm, setSearchTerm] = useState("");
  const [topicFilterSelected, setTopicFilterSelected] = useState(() => new Set());
  const [sessionFilterSelected, setSessionFilterSelected] = useState(() => new Set());
  const [topicFilterQuery, setTopicFilterQuery] = useState("");
  const [sessionFilterQuery, setSessionFilterQuery] = useState("");
  const [topicDropdownOpen, setTopicDropdownOpen] = useState(false);
  const [sessionDropdownOpen, setSessionDropdownOpen] = useState(false);
  const [showFavoritesOnly, setShowFavoritesOnly] = useState(false);
  const [legendExpanded, setLegendExpanded] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_STORAGE_KEY) !== "0";
    } catch {
      return true;
    }
  });
  const [showTable, setShowTable] = useState(false);
  const [tableAgendaMode, setTableAgendaMode] = useState(false);
  const [tableHeight, setTableHeight] = useState(350);
  const [tooltipData, setTooltipData] = useState(null);
  const [tablePage, setTablePage] = useState(0);
  const [autoRotate, setAutoRotate] = useState(false);
  const [spinPaused, setSpinPaused] = useState(false);
  const spinResumeTimer = useRef(null);
  const TABLE_PAGE_SIZE = 50;
  const TABLE_DOCK_MS = 340;

  const [tableDockInDom, setTableDockInDom] = useState(false);
  const [tableGridOpen, setTableGridOpen] = useState(false);

  useEffect(() => {
    if (showTable) {
      setTableDockInDom(true);
      setTableGridOpen(false);
      return;
    }
    setTableGridOpen(false);
    const t = window.setTimeout(() => setTableDockInDom(false), TABLE_DOCK_MS);
    return () => window.clearTimeout(t);
  }, [showTable]);

  useEffect(() => {
    if (!showTable || !tableDockInDom) return;
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setTableGridOpen(true));
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [showTable, tableDockInDom]);

  useEffect(() => {
    clearTimeout(spinResumeTimer.current);
    if (hoveredId !== null) {
      setSpinPaused(true);
    } else {
      spinResumeTimer.current = setTimeout(() => setSpinPaused(false), 300);
    }
    return () => clearTimeout(spinResumeTimer.current);
  }, [hoveredId]);

  const orbitControlsRef = useRef(null);

  const handleReset = useCallback(() => { orbitControlsRef.current?.reset(); }, []);

  // Shift key → lock horizontal orbit
  useEffect(() => {
    const onDown = (e) => {
      if (e.key === "Shift" && orbitControlsRef.current) {
        const p = orbitControlsRef.current.getPolarAngle();
        orbitControlsRef.current.minPolarAngle = p;
        orbitControlsRef.current.maxPolarAngle = p;
      }
    };
    const onUp = (e) => {
      if (e.key === "Shift" && orbitControlsRef.current) {
        orbitControlsRef.current.minPolarAngle = 0;
        orbitControlsRef.current.maxPolarAngle = Math.PI;
      }
    };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    return () => { window.removeEventListener("keydown", onDown); window.removeEventListener("keyup", onUp); };
  }, []);

  // Load precomputed data
  useEffect(() => {
    (async () => {
      try {
        const resp = await fetch(import.meta.env.BASE_URL + "aacr_data.json");
        const data = await resp.json();
        setLoadingStatus(`Loading ${data.length} abstracts...`);
        setAbstracts(data);
        setEmbeddings(data.map((d) => ({ x: d.x, y: d.y, z: d.z ?? 0.5 })));
        setLoading(false);
      } catch (e) {
        setLoadingStatus(`Error: ${e.message}`);
      }
    })();
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(FAVORITE_IDS_KEY, JSON.stringify(favoriteIds));
    } catch { /* ignore */ }
  }, [favoriteIds]);

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_STORAGE_KEY, sidebarOpen ? "1" : "0");
    } catch { /* ignore */ }
  }, [sidebarOpen]);

  const activeListIds = useMemo(() => new Set(favoriteIds), [favoriteIds]);

  const idToColor = useMemo(() => {
    const m = new Map();
    favoriteIds.forEach((id) => m.set(id, FAVORITE_POINT_COLOR));
    return m;
  }, [favoriteIds]);

  const listVisuals = useMemo(() => ({
    activeIds: activeListIds,
    idToColor,
    tintOthers: !showFavoritesOnly,
  }), [activeListIds, idToColor, showFavoritesOnly]);

  const toggleFavorite = useCallback((id) => {
    setFavoriteIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }, []);

  const removeFavorite = useCallback((id) => {
    setFavoriteIds((prev) => prev.filter((x) => x !== id));
  }, []);

  const abstractById = useMemo(() => {
    const m = new Map();
    abstracts.forEach((a) => m.set(a.id, a));
    return m;
  }, [abstracts]);

  const favoriteAbstractsOrdered = useMemo(
    () => favoriteIds.map((id) => abstractById.get(id)).filter(Boolean),
    [favoriteIds, abstractById],
  );

  const toggleTopicFilter = useCallback((topic) => {
    setTopicFilterSelected((prev) => {
      const n = new Set(prev);
      if (n.has(topic)) n.delete(topic);
      else n.add(topic);
      return n;
    });
    setTablePage(0);
  }, []);

  const toggleSessionFilter = useCallback((sess) => {
    setSessionFilterSelected((prev) => {
      const n = new Set(prev);
      if (n.has(sess)) n.delete(sess);
      else n.add(sess);
      return n;
    });
    setTablePage(0);
  }, []);

  const clearTopicFilters = useCallback(() => {
    setTopicFilterSelected(new Set());
    setTablePage(0);
  }, []);

  const clearSessionFilters = useCallback(() => {
    setSessionFilterSelected(new Set());
    setTablePage(0);
  }, []);

  useEffect(() => {
    const onDoc = (e) => {
      if (!e.target.closest?.(".filter-dropdown-wrap")) {
        setTopicDropdownOpen(false);
        setSessionDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  // Derived data
  const clusterTopics = useMemo(() => {
    const counts = {};
    abstracts.forEach((a) => { const t = a.clusterTopic || "Unknown"; counts[t] = (counts[t] || 0) + 1; });
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([topic, count]) => ({ topic, count }));
  }, [abstracts]);

  const sessions = useMemo(() => [...new Set(abstracts.map((a) => a.session))].sort(), [abstracts]);

  const filteredTopicOptions = useMemo(() => {
    const q = topicFilterQuery.trim().toLowerCase();
    let list = clusterTopics;
    if (q) list = clusterTopics.filter(({ topic }) => topic.toLowerCase().includes(q));
    else if (list.length > FILTER_LIST_CAP) list = list.slice(0, FILTER_LIST_CAP);
    return list;
  }, [clusterTopics, topicFilterQuery]);

  const filteredSessionOptions = useMemo(() => {
    const q = sessionFilterQuery.trim().toLowerCase();
    let list = sessions;
    if (q) list = sessions.filter((s) => s.toLowerCase().includes(q));
    else if (list.length > FILTER_LIST_CAP) list = list.slice(0, FILTER_LIST_CAP);
    return list;
  }, [sessions, sessionFilterQuery]);

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
      if (!(t in colors)) colors[t] = topicLabelColor(t);
    });
    return colors;
  }, [abstracts]);


  // Search similarity: 3D centroid distance
  const searchSimilarity = useMemo(() => {
    if (!searchTerm || searchTerm.length < 2 || embeddings.length === 0) return null;
    const term = searchTerm.trim();
    const matches = [];
    abstracts.forEach((a, i) => {
      if (abstractMatchesSearch(a, term)) matches.push(i);
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
    const term = searchTerm.trim();
    return abstracts.map((_, i) => i).filter((i) => {
      const a = abstracts[i];
      if (showFavoritesOnly && !activeListIds.has(a.id)) return false;
      if (topicFilterSelected.size > 0 && !topicFilterSelected.has(a.clusterTopic || "Unknown")) return false;
      if (sessionFilterSelected.size > 0 && !sessionFilterSelected.has(a.session)) return false;
      if (term && !abstractMatchesSearch(a, term)) return false;
      return true;
    });
  }, [abstracts, searchTerm, topicFilterSelected, sessionFilterSelected, showFavoritesOnly, activeListIds]);

  const filteredSet = useMemo(() => new Set(filteredIndices), [filteredIndices]);

  // Table resize
  const handleTableResizeStart = (e) => {
    e.preventDefault();
    const startY = e.clientY, startH = tableHeight;
    const onMove = (ev) => setTableHeight(Math.max(150, Math.min(window.innerHeight * 0.8, startH + startY - ev.clientY)));
    const onUp = () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  // CSV Export
  const exportCSV = (favOnly = false) => {
    const items = favOnly ? abstracts.filter((a) => activeListIds.has(a.id)) : filteredIndices.map((i) => abstracts[i]);
    const escape = (s) => `"${String(s).replace(/"/g, '""')}"`;
    const header = "ID,Title,Authors,Institution,Session,Start,Topic,Poster Number,Presenter,Abstract";
    const rows = items.map((a) =>
      [a.id, a.title, a.authors.join("; "), a.institution, a.session, a.start || "", a.clusterTopic, a.posterNumber, a.presenter, a.abstract.replace(/\n/g, " ")].map(escape).join(",")
    );
    const blob = new Blob([[header, ...rows].join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = favOnly ? "aacr_favorites.csv" : "aacr_abstracts_all.csv";
    link.click(); URL.revokeObjectURL(url);
  };

  const selected = selectedId !== null ? abstracts[selectedId] : null;
  const tableData = useMemo(() => filteredIndices.map((i) => abstracts[i]), [filteredIndices, abstracts]);

  const sortedTableAbstracts = useMemo(() => {
    const r = [...tableData];
    if (showFavoritesOnly || tableAgendaMode) {
      r.sort((a, b) => parseStartMs(a.start) - parseStartMs(b.start));
    }
    return r;
  }, [tableData, showFavoritesOnly, tableAgendaMode]);

  const totalTablePages = Math.max(1, Math.ceil(sortedTableAbstracts.length / TABLE_PAGE_SIZE));
  const pageStart = tablePage * TABLE_PAGE_SIZE;
  const tablePageAbstracts = useMemo(
    () => sortedTableAbstracts.slice(pageStart, pageStart + TABLE_PAGE_SIZE),
    [sortedTableAbstracts, pageStart],
  );
  const prevPageLastAbstract = pageStart > 0 ? sortedTableAbstracts[pageStart - 1] : null;

  useEffect(() => {
    const pages = Math.max(1, Math.ceil(sortedTableAbstracts.length / TABLE_PAGE_SIZE));
    if (tablePage > pages - 1) setTablePage(Math.max(0, pages - 1));
  }, [sortedTableAbstracts.length, tablePage]);

  if (loading) {
    return (
      <div style={{ width: "100vw", height: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: "#151720", color: "#8a919c", fontFamily: "'JetBrains Mono', 'Fira Code', monospace" }}>
        <style>{`@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500&family=DM+Sans:wght@400;500;600;700&display=swap'); @keyframes pulse { 0%,100% { opacity: 0.3; } 50% { opacity: 1; } }`}</style>
        <div style={{ fontSize: 16, letterSpacing: 6, textTransform: "uppercase", marginBottom: 36, color: "#00ff9f", animation: "pulse 2s infinite" }}>AACR 2026 Explorer</div>
        <div style={{ fontSize: 18, color: "#c8cdd6" }}>{loadingStatus}</div>
      </div>
    );
  }

  return (
    <div style={{ width: "100vw", height: "100vh", overflow: "hidden", background: "#151720", color: "#e8eaef", fontFamily: "'JetBrains Mono', 'Fira Code', monospace", position: "relative" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500&family=DM+Sans:ital,wght@0,400;0,500;0,600;0,700;1,400&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { width: 8px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.16); border-radius: 4px; }
        .top-bar { position: fixed; top: 0; left: 0; right: 0; height: ${TOP_BAR_PX}px; z-index: 50; display: flex; align-items: center; gap: 10px; padding: 0 12px 0 8px; background: rgba(26,28,38,0.97); backdrop-filter: blur(14px); border-bottom: 1px solid rgba(255,255,255,0.1); }
        .sidebar-toggle { flex-shrink: 0; width: 40px; height: 36px; display: flex; align-items: center; justify-content: center; border: 1px solid rgba(255,255,255,0.12); border-radius: 4px; background: rgba(255,255,255,0.06); color: #a0a6b4; cursor: pointer; font-size: 18px; transition: all 0.15s; }
        .sidebar-toggle:hover { border-color: rgba(0,255,159,0.35); color: #00ff9f; }
        .top-bar .logo { font-family: 'DM Sans', sans-serif; font-weight: 700; font-size: 16px; color: #00ff9f; letter-spacing: 3px; text-transform: uppercase; white-space: nowrap; user-select: none; flex-shrink: 0; }
        .top-bar .logo span { color: #7d8594; font-weight: 400; }
        .top-bar-search:focus { border-color: rgba(0,255,159,0.4); }
        .top-bar-search::placeholder { color: #7d8594; }
        .top-bar-tools { display: flex; align-items: center; gap: 6px; flex-shrink: 0; margin-left: auto; }
        .top-bar-search { flex: 1; min-width: 120px; max-width: 520px; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.12); color: #e4e7ed; font-family: 'JetBrains Mono', monospace; font-size: 13px; padding: 7px 12px; border-radius: 4px; outline: none; transition: border-color 0.2s; }
        .filter-dropdown-wrap { display: flex; align-items: center; gap: 8px; flex-shrink: 0; position: relative; z-index: 55; }
        .filter-dropdown-panel { position: absolute; top: calc(100% + 8px); left: 0; min-width: 300px; max-width: min(420px, calc(100vw - 24px)); max-height: min(72vh, 520px); z-index: 60; display: flex; flex-direction: column; padding: 10px 12px; background: rgba(32,34,46,0.98); border: 1px solid rgba(255,255,255,0.14); border-radius: 6px; box-shadow: 0 12px 40px rgba(0,0,0,0.35); transform-origin: top left; animation: paneDropIn 0.24s cubic-bezier(0.22, 1, 0.36, 1) both; }
        .filter-dropdown-wrap > div:nth-child(2) .filter-dropdown-panel { left: auto; right: 0; transform-origin: top right; }
        .filter-check-list { overflow-y: auto; flex: 1; min-height: 0; margin-top: 8px; max-height: 280px; border: 1px solid rgba(255,255,255,0.08); border-radius: 4px; padding: 4px 0; background: rgba(0,0,0,0.12); }
        .filter-check-row { display: flex; align-items: flex-start; gap: 8px; padding: 6px 10px; font-size: 12px; color: #c4cad4; cursor: pointer; }
        .filter-check-row:hover { background: rgba(0,255,159,0.06); }
        .filter-check-row input { margin-top: 2px; accent-color: #00ff9f; flex-shrink: 0; }
        .filter-check-label { flex: 1; line-height: 1.4; min-width: 0; }
        .app-main { position: fixed; z-index: 1; display: flex; flex-direction: column; overflow: hidden; transition: left 0.32s cubic-bezier(0.22, 1, 0.36, 1); }
        .main-vis { flex: 1 1 auto; min-height: 0; position: relative; }
        .canvas-wrap { position: absolute; inset: 0; z-index: 1; overflow: hidden; }
        .legend-floating { position: absolute; top: 14px; right: 14px; bottom: auto; width: min(300px, calc(100% - 28px)); max-height: min(38vh, calc(100% - 28px)); z-index: 22; background: rgba(28,30,42,0.96); border: 1px solid rgba(255,255,255,0.12); backdrop-filter: blur(12px); border-radius: 8px; padding: 12px 14px; display: flex; flex-direction: column; box-shadow: 0 8px 32px rgba(0,0,0,0.3); animation: legendPaneIn 0.28s cubic-bezier(0.22, 1, 0.36, 1) both; }
        .legend-tab { position: absolute; top: 14px; right: 14px; bottom: auto; z-index: 22; background: rgba(28,30,42,0.96); border: 1px solid rgba(255,255,255,0.14); color: #c4cad4; font-family: 'JetBrains Mono', monospace; font-size: 11px; padding: 8px 12px; border-radius: 6px; cursor: pointer; letter-spacing: 1px; text-transform: uppercase; animation: legendPaneIn 0.28s cubic-bezier(0.22, 1, 0.36, 1) both; }
        .hints { position: absolute; bottom: 16px; left: 14px; z-index: 18; text-align: left; user-select: none; max-width: min(320px, 45vw); }
        .favorites-list { margin-top: 10px; border: 1px solid rgba(255,255,255,0.1); border-radius: 4px; max-height: 42vh; overflow-y: auto; background: rgba(0,0,0,0.1); }
        .fav-row { display: flex; align-items: flex-start; gap: 8px; padding: 8px 10px; border-bottom: 1px solid rgba(255,255,255,0.06); cursor: pointer; font-size: 12px; color: #b8c0cc; }
        .fav-row:hover { background: rgba(0,255,159,0.06); color: #f0f2f5; }
        .fav-row-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; line-height: 1.4; }
        .fav-row-remove { opacity: 0; flex-shrink: 0; width: 28px; height: 28px; border: none; background: rgba(255,80,80,0.12); color: #ff6b6b; border-radius: 4px; cursor: pointer; font-size: 18px; line-height: 1; transition: opacity 0.12s; }
        .fav-row:hover .fav-row-remove { opacity: 1; }
        .table-dock-shell { flex-shrink: 0; display: grid; grid-template-rows: 0fr; transition: grid-template-rows 0.34s cubic-bezier(0.22, 1, 0.36, 1); }
        .table-dock-shell.is-open { grid-template-rows: 1fr; }
        .table-dock-shell-inner { min-height: 0; overflow: hidden; }
        .table-dock { display: flex; flex-direction: column; border-top: 1px solid rgba(255,255,255,0.12); background: rgba(26,28,38,0.99); backdrop-filter: blur(16px); box-shadow: 0 -8px 32px rgba(0,0,0,0.32); z-index: 12; }
        .table-dock .table-panel { width: 100%; max-height: none; }

        .stat { font-size: 11px; color: #8d95a3; letter-spacing: 1px; text-transform: uppercase; white-space: nowrap; }
        .stat b { color: #00ff9f; font-weight: 500; }
        .ctrl-btn { background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1); color: #c4cad4; font-family: 'JetBrains Mono', monospace; font-size: 12px; padding: 6px 10px; border-radius: 4px; cursor: pointer; transition: all 0.15s; white-space: nowrap; }
        .ctrl-btn:hover { background: rgba(0,255,159,0.06); border-color: rgba(0,255,159,0.3); color: #00ff9f; }
        .ctrl-btn.active { background: rgba(0,255,159,0.1); border-color: rgba(0,255,159,0.4); color: #00ff9f; }
        .app-sidebar { position: fixed; top: ${TOP_BAR_PX}px; left: 0; width: ${SIDEBAR_WIDTH_PX}px; bottom: 0; z-index: 25; display: flex; flex-direction: column; background: rgba(28,30,40,0.97); backdrop-filter: blur(18px); border-right: 1px solid rgba(255,255,255,0.1); transition: transform 0.32s cubic-bezier(0.22, 1, 0.36, 1); will-change: transform; }
        .app-sidebar.is-collapsed { transform: translateX(-100%); pointer-events: none; }
        .sidebar-section { flex: 1 1 50%; min-height: 0; overflow-y: auto; padding: 12px 14px; }
        .sidebar-lists { border-bottom: 1px solid rgba(255,255,255,0.1); }
        .sidebar-section h3 { font-size: 10px; letter-spacing: 2px; color: #9aa3b0; text-transform: uppercase; margin: 12px 0 6px; }
        .sidebar-section h3:first-child { margin-top: 0; }
        .sidebar-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-bottom: 8px; }
        .sidebar-row select, .sidebar-row .filter-q { background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.12); color: #e0e4ea; font-family: 'JetBrains Mono', monospace; font-size: 12px; padding: 5px 8px; border-radius: 4px; outline: none; }
        .sidebar-row select { flex: 1; min-width: 120px; }
        .filter-q { width: 100%; margin-top: 4px; }
        .filter-q:focus { border-color: rgba(0,255,159,0.35); }
        .filter-hint { font-size: 10px; color: #8d95a3; margin-top: 4px; }
        .filter-pick-list { max-height: 100px; overflow-y: auto; border: 1px solid rgba(255,255,255,0.1); border-radius: 4px; margin-top: 4px; background: rgba(0,0,0,0.12); }
        .filter-pick-row { padding: 5px 8px; font-size: 11px; cursor: pointer; color: #b0b8c4; border-bottom: 1px solid rgba(255,255,255,0.06); line-height: 1.3; }
        .filter-pick-row:hover { background: rgba(0,255,159,0.06); color: #f0f2f5; }
        .filter-pick-row.active { color: #00ff9f; }
        .sidebar-details { display: flex; flex-direction: column; }
        .sidebar-details-inner { position: relative; padding-top: 4px; }
        .sidebar-details-inner .close-btn { position: static; float: right; width: 32px; height: 32px; margin: 0 0 8px 8px; }
        .detail-panel { font-family: inherit; }
        .detail-panel h2 { font-family: 'DM Sans', sans-serif; font-size: 17px; font-weight: 600; color: #f2f4f7; line-height: 1.45; margin-bottom: 14px; clear: both; }
        .detail-meta { font-size: 13px; color: #b4bcc8; margin-bottom: 6px; line-height: 1.5; }
        .detail-meta b { color: #d8dee6; font-weight: 500; }
        .detail-tags { display: flex; flex-wrap: wrap; gap: 6px; margin: 14px 0; }
        .detail-tag { font-size: 11px; padding: 4px 8px; border-radius: 3px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1); color: #a8b0bc; letter-spacing: 0.5px; text-transform: uppercase; }
        .detail-tag.topic { border-color: var(--topic-color, #00ff9f); color: var(--topic-color, #00ff9f); background: rgba(0,255,159,0.08); }
        .detail-abstract { font-family: 'DM Sans', sans-serif; font-size: 14px; line-height: 1.75; color: #c4cad4; margin-top: 14px; white-space: pre-wrap; border-top: 1px solid rgba(255,255,255,0.1); padding-top: 14px; }
        .fav-btn { display: inline-flex; align-items: center; gap: 6px; background: rgba(255,217,61,0.05); border: 1px solid rgba(255,217,61,0.15); color: #ffd93d; font-family: 'JetBrains Mono', monospace; font-size: 12px; padding: 7px 14px; border-radius: 4px; cursor: pointer; transition: all 0.15s; margin-top: 12px; }
        .fav-btn:hover { background: rgba(255,217,61,0.1); }
        .fav-btn.is-fav { background: rgba(255,217,61,0.12); border-color: rgba(255,217,61,0.3); }
        .close-btn { background: none; border: 1px solid rgba(255,255,255,0.1); color: #9aa3b0; display: flex; align-items: center; justify-content: center; border-radius: 4px; cursor: pointer; font-size: 18px; transition: all 0.15s; }
        .close-btn:hover { border-color: #ff6b6b; color: #ff6b6b; }
        .detail-empty { color: #9aa3b0; font-size: 12px; line-height: 1.65; padding: 16px 0; }

        .tooltip { position: absolute; z-index: 30; background: rgba(30,32,44,0.97); border: 1px solid rgba(255,255,255,0.12); backdrop-filter: blur(12px); padding: 12px 14px; border-radius: 6px; pointer-events: none; max-width: min(420px, 90%); animation: tooltipIn 0.22s cubic-bezier(0.22, 1, 0.36, 1); }
        @keyframes tooltipIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
        .tooltip h4 { font-family: 'DM Sans', sans-serif; font-size: 14px; font-weight: 500; color: #f0f2f5; margin-bottom: 6px; line-height: 1.35; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
        .tooltip p { font-size: 12px; color: #b4bcc8; line-height: 1.35; }

        .legend-floating .legend-scroll { overflow-y: auto; flex: 1; min-height: 0; margin-top: 6px; }
        .legend-floating h5 { font-size: 10px; color: #9aa3b0; letter-spacing: 2px; text-transform: uppercase; }
        .legend-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-shrink: 0; }
        .legend-collapse { background: none; border: none; color: #a8b0bc; cursor: pointer; font-size: 18px; line-height: 1; padding: 2px 6px; border-radius: 4px; }
        .legend-collapse:hover { color: #00ff9f; }

        .legend-tab:hover { color: #00ff9f; border-color: rgba(0,255,159,0.3); }
        .legend-item { display: flex; align-items: center; gap: 8px; font-size: 12px; color: #b4bcc8; margin-bottom: 4px; cursor: pointer; transition: color 0.15s; }
        .legend-item:hover { color: #f0f2f5; }
        .legend-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
        .legend-count { color: #7d8594; margin-left: auto; font-size: 10px; }
        .table-panel { background: transparent; display: flex; flex-direction: column; }
        @keyframes paneDropIn { from { opacity: 0; transform: translateY(-8px) scale(0.98); } to { opacity: 1; transform: translateY(0) scale(1); } }
        @keyframes legendPaneIn { from { opacity: 0; transform: translateY(-10px); } to { opacity: 1; transform: translateY(0); } }
        .table-resize-handle { height: 6px; cursor: ns-resize; background: transparent; flex-shrink: 0; display: flex; align-items: center; justify-content: center; }
        .table-resize-handle::after { content: ''; width: 40px; height: 3px; border-radius: 2px; background: rgba(255,255,255,0.18); }
        .table-resize-handle:hover::after { background: rgba(0,255,159,0.35); }
        .table-header { display: flex; align-items: center; justify-content: space-between; padding: 10px 16px; border-bottom: 1px solid rgba(255,255,255,0.1); flex-shrink: 0; }
        .table-header span { font-size: 12px; color: #9aa3b0; letter-spacing: 2px; text-transform: uppercase; }
        .table-body { overflow-y: auto; flex: 1; }
        .table-body table { width: 100%; border-collapse: collapse; font-size: 12px; }
        .table-body th { position: sticky; top: 0; background: #22242e; color: #a8b0bc; font-weight: 500; text-align: left; padding: 9px 12px; border-bottom: 1px solid rgba(255,255,255,0.1); font-size: 11px; letter-spacing: 1px; text-transform: uppercase; white-space: nowrap; }
        .table-body td { padding: 9px 12px; border-bottom: 1px solid rgba(255,255,255,0.06); color: #c4cad4; max-width: 400px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .table-body tr { cursor: pointer; transition: background 0.1s; }
        .table-body tr:hover { background: rgba(0,255,159,0.05); }
        .table-body tr:hover td { color: #f0f2f5; }
        .table-body tr.table-agenda-date td { background: rgba(0,255,159,0.06); color: #00ff9f; font-size: 11px; letter-spacing: 2px; text-transform: uppercase; font-weight: 600; border-bottom: 1px solid rgba(0,255,159,0.12); cursor: default; }
        .table-body tr.table-agenda-date:hover { background: transparent; }
        .table-pager { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
        .table-pager button { background: none; border: 1px solid rgba(255,255,255,0.1); color: #b0b8c4; font-family: 'JetBrains Mono', monospace; font-size: 12px; padding: 4px 10px; border-radius: 3px; cursor: pointer; }
        .table-pager button:hover { border-color: rgba(0,255,159,0.3); color: #00ff9f; }
        .table-pager button:disabled { opacity: 0.3; cursor: default; }
        .table-pager span { font-size: 12px; color: #9aa3b0; }

        .hints p { font-size: 10px; color: #8d95a3; letter-spacing: 1px; line-height: 1.75; }
        .hints p b { color: #c4cad4; }
      `}</style>

      <header className="top-bar">
        <button
          type="button"
          className="sidebar-toggle"
          aria-expanded={sidebarOpen}
          aria-label={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
          onClick={() => setSidebarOpen((v) => !v)}
        >
          {sidebarOpen ? "<<" : ">>"}
        </button>
        <div className="logo">AACR<span>.</span>2026</div>
        <input
          type="search"
          className="top-bar-search"
          placeholder="Search titles, topics, sessions, authors, keywords..."
          value={searchTerm}
          onChange={(e) => { setSearchTerm(e.target.value); setTablePage(0); }}
        />
        <div className="filter-dropdown-wrap">
          <div style={{ position: "relative" }}>
            <button
              type="button"
              className="ctrl-btn"
              onClick={() => { setTopicDropdownOpen((o) => !o); setSessionDropdownOpen(false); }}
            >
              Topics{topicFilterSelected.size ? ` (${topicFilterSelected.size})` : ""}
            </button>
            {topicDropdownOpen ? (
              <div className="filter-dropdown-panel" onMouseDown={(e) => e.stopPropagation()}>
                <input
                  type="search"
                  className="filter-q"
                  placeholder="Filter topics..."
                  value={topicFilterQuery}
                  onChange={(e) => setTopicFilterQuery(e.target.value)}
                />
                {!topicFilterQuery.trim() && clusterTopics.length > FILTER_LIST_CAP ? (
                  <div className="filter-hint">First {FILTER_LIST_CAP} shown. Type to narrow.</div>
                ) : null}
                <div className="filter-check-list">
                  {filteredTopicOptions.map(({ topic, count }) => (
                    <label key={topic} className="filter-check-row">
                      <input
                        type="checkbox"
                        checked={topicFilterSelected.has(topic)}
                        onChange={() => toggleTopicFilter(topic)}
                      />
                      <span className="filter-check-label">{topic}</span>
                      <span className="legend-count">{count}</span>
                    </label>
                  ))}
                </div>
                {topicFilterSelected.size > 0 ? (
                  <button type="button" className="ctrl-btn" style={{ width: "100%", marginTop: 8 }} onClick={clearTopicFilters}>Clear topics</button>
                ) : null}
              </div>
            ) : null}
          </div>
          <div style={{ position: "relative" }}>
            <button
              type="button"
              className="ctrl-btn"
              onClick={() => { setSessionDropdownOpen((o) => !o); setTopicDropdownOpen(false); }}
            >
              Sessions{sessionFilterSelected.size ? ` (${sessionFilterSelected.size})` : ""}
            </button>
            {sessionDropdownOpen ? (
              <div className="filter-dropdown-panel" onMouseDown={(e) => e.stopPropagation()}>
                <input
                  type="search"
                  className="filter-q"
                  placeholder="Filter sessions..."
                  value={sessionFilterQuery}
                  onChange={(e) => setSessionFilterQuery(e.target.value)}
                />
                {!sessionFilterQuery.trim() && sessions.length > FILTER_LIST_CAP ? (
                  <div className="filter-hint">First {FILTER_LIST_CAP} shown. Type to narrow.</div>
                ) : null}
                <div className="filter-check-list">
                  {filteredSessionOptions.map((s) => (
                    <label key={s} className="filter-check-row">
                      <input
                        type="checkbox"
                        checked={sessionFilterSelected.has(s)}
                        onChange={() => toggleSessionFilter(s)}
                      />
                      <span className="filter-check-label">{s}</span>
                    </label>
                  ))}
                </div>
                {sessionFilterSelected.size > 0 ? (
                  <button type="button" className="ctrl-btn" style={{ width: "100%", marginTop: 8 }} onClick={clearSessionFilters}>Clear sessions</button>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
        <div className="top-bar-tools">
          <span className="stat"><b>{filteredIndices.length}</b> / {abstracts.length}</span>
          <button type="button" className={`ctrl-btn ${autoRotate ? "active" : ""}`} onClick={() => setAutoRotate((v) => !v)}>Spin</button>
          <button type="button" className="ctrl-btn" onClick={handleReset}>Reset</button>
        </div>
      </header>

      <aside
        className={`app-sidebar${sidebarOpen ? "" : " is-collapsed"}`}
        aria-label="Lists and details"
        aria-hidden={!sidebarOpen}
      >
          <div className="sidebar-section sidebar-lists">
            <h3>Favorites</h3>
            <div className="sidebar-row">
              <button type="button" className="ctrl-btn" onClick={() => exportCSV(true)} title="Download favorites as CSV">Download</button>
              <button
                type="button"
                className={`ctrl-btn ${showFavoritesOnly ? "active" : ""}`}
                title="Show only favorited abstracts in the map and table"
                onClick={() => setShowFavoritesOnly(!showFavoritesOnly)}
              >
                Favorites only ({favoriteIds.length})
              </button>
            </div>
            <div className="sidebar-row">
              <button type="button" className={`ctrl-btn ${showTable ? "active" : ""}`} onClick={() => { setShowTable(!showTable); setTablePage(0); }}>Table</button>
              <button type="button" className={`ctrl-btn ${tableAgendaMode ? "active" : ""}`} onClick={() => { setTableAgendaMode((v) => !v); setTablePage(0); }}>Agenda</button>
              <button type="button" className="ctrl-btn" onClick={() => exportCSV(false)}>Export all</button>
            </div>
            <div className="favorites-list">
              {favoriteAbstractsOrdered.length === 0 ? (
                <div className="detail-empty" style={{ padding: "12px 14px" }}>Use the star in details or the table to add favorites. They appear here in order.</div>
              ) : (
                favoriteAbstractsOrdered.map((a) => (
                  <div
                    key={a.id}
                    className="fav-row"
                    onClick={() => {
                      const idx = abstracts.findIndex((x) => x.id === a.id);
                      setSelectedId(idx >= 0 ? idx : null);
                    }}
                  >
                    <span className="fav-row-title">{a.title}</span>
                    <button
                      type="button"
                      className="fav-row-remove"
                      title="Remove from favorites"
                      onClick={(e) => { e.stopPropagation(); removeFavorite(a.id); }}
                    >
                      ×
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="sidebar-section sidebar-details">
            <h3>Details</h3>
            {selected ? (
              <div className="sidebar-details-inner detail-panel">
                <button type="button" className="close-btn" title="Clear selection" onClick={() => setSelectedId(null)}>×</button>
                <div style={{ fontSize: 10, color: "#8d95a3", letterSpacing: 2, marginBottom: 10 }}>#{selected.id} · POSTER {selected.posterNumber} · {selected.start}</div>
                <h2>{selected.title}</h2>
                <div className="detail-meta"><b>Presenter:</b> {selected.presenter}</div>
                <AffiliationView institution={selected.institution} authors={selected.authors} />
                <div className="detail-meta"><b>Session:</b> {selected.session}</div>
                <div className="detail-tags">
                  <span className="detail-tag topic" style={{ "--topic-color": topicColors[selected.clusterTopic] }}>{selected.clusterTopic}</span>
                </div>
                <button
                  type="button"
                  className={`fav-btn ${activeListIds.has(selected.id) ? "is-fav" : ""}`}
                  onClick={() => toggleFavorite(selected.id)}
                >
                  {activeListIds.has(selected.id) ? "Remove from favorites" : "Add to favorites"}
                </button>
                {selected.abstract && <div className="detail-abstract">{selected.abstract}</div>}
              </div>
            ) : (
              <div className="detail-empty">Select a point on the map to see title, session, time, and abstract.</div>
            )}
          </div>
      </aside>

      <div
        className="app-main"
        style={{
          top: TOP_BAR_PX,
          left: sidebarOpen ? SIDEBAR_WIDTH_PX : 0,
          right: 0,
          bottom: 0,
        }}
      >
        <div className="main-vis">
          <div className="canvas-wrap">
            <Canvas
              camera={{ position: [0, 0, 2], fov: 60, near: 0.01, far: 100 }}
              style={{ width: "100%", height: "100%", display: "block" }}
              gl={{ antialias: true }}
            >
              <color attach="background" args={["#151720"]} />
              <PointCloud
                abstracts={abstracts}
                embeddings={embeddings}
                filteredSet={filteredSet}
                filteredIndices={filteredIndices}
                searchSimilarity={searchSimilarity}
                clusterColors={clusterColors}
                topicColors={topicColors}
                topicFilterSelected={topicFilterSelected}
                selectedId={selectedId}
                onHover={setHoveredId}
                onSelect={setSelectedId}
                onTooltipPos={setTooltipData}
                listVisuals={listVisuals}
              />

              <OrbitControls
                ref={orbitControlsRef}
                enableDamping
                dampingFactor={0.08}
                enableZoom={false}
                minDistance={ZOOM_MIN}
                maxDistance={ZOOM_MAX}
                target={[0, 0, 0]}
                autoRotate={autoRotate && !spinPaused}
                autoRotateSpeed={0.5}
              />
              <SmoothZoom minDist={ZOOM_MIN} maxDist={ZOOM_MAX} />
              <GizmoHelper alignment="bottom-right" margin={[72, 168]}>
                <GizmoViewport axisColors={["#ff6b6b", "#00ff9f", "#60a5fa"]} labelColor="white" />
              </GizmoHelper>
            </Canvas>

            {tooltipData && !selected && (
              <div
                className="tooltip"
                style={{ left: tooltipData.sx + 14, top: tooltipData.sy + 14 }}
              >
                <h4>{tooltipData.abstract.title}</h4>
                <p>{tooltipData.abstract.authors.slice(0, 3).join(", ")}{tooltipData.abstract.authors.length > 3 ? " et al." : ""}</p>
                <p style={{ color: topicColors[tooltipData.abstract.clusterTopic], marginTop: 2 }}>{tooltipData.abstract.clusterTopic} · #{tooltipData.abstract.posterNumber}</p>
                {tooltipData.abstract.start && <p style={{ marginTop: 4, color: "#a8b0bc" }}>{tooltipData.abstract.start}</p>}
              </div>
            )}
          </div>

          {legendExpanded ? (
            <div className="legend-floating">
              <div className="legend-head">
                <h5>Topic clusters</h5>
                <button type="button" className="legend-collapse" aria-label="Collapse legend" onClick={() => setLegendExpanded(false)}>−</button>
              </div>
              <div className="legend-scroll">
                {clusterTopics.map(({ topic, count }) => (
                  <div key={topic} className="legend-item" onClick={() => toggleTopicFilter(topic)}>
                    <div className="legend-dot" style={{ background: topicColors[topic] }} />
                    <span style={topicFilterSelected.has(topic) ? { color: topicColors[topic] } : {}}>{topic}</span>
                    <span className="legend-count">{count}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <button type="button" className="legend-tab" onClick={() => setLegendExpanded(true)}>Topics</button>
          )}

          {!showTable && (
            <div className="hints">
              <p>DRAG <b>ROTATE</b> · SCROLL <b>ZOOM</b> · RIGHT-DRAG <b>PAN</b></p>
              <p>SHIFT + DRAG <b>LOCK HORIZONTAL</b></p>
            </div>
          )}
        </div>

        {tableDockInDom && (
          <div className={`table-dock-shell${tableGridOpen ? " is-open" : ""}`}>
            <div className="table-dock-shell-inner">
              <div className="table-dock">
                <div className="table-panel" style={{ height: tableHeight }} onClick={(e) => e.stopPropagation()}>
                  <div className="table-resize-handle" onMouseDown={handleTableResizeStart} />
                  <div className="table-header">
                    <span>Abstracts ({sortedTableAbstracts.length})</span>
                    <div className="table-pager">
                      <button type="button" className={`ctrl-btn ${tableAgendaMode ? "active" : ""}`} style={{ padding: "4px 10px", fontSize: 12 }} onClick={() => { setTableAgendaMode((v) => !v); setTablePage(0); }}>Agenda</button>
                      <button type="button" disabled={tablePage === 0} onClick={() => setTablePage((p) => p - 1)}>Prev</button>
                      <span>{tablePage + 1} / {totalTablePages}</span>
                      <button type="button" disabled={tablePage >= totalTablePages - 1} onClick={() => setTablePage((p) => p + 1)}>Next</button>
                      <button type="button" className="close-btn" style={{ position: "static", width: 28, height: 28, fontSize: 16 }} onClick={() => setShowTable(false)}>×</button>
                    </div>
                  </div>
                  <div className="table-body">
                    <table>
                      <thead><tr><th>ID</th><th>Start</th><th>Poster</th><th>Title</th><th>Presenter</th><th>Session</th><th>Topic</th><th>Fav</th></tr></thead>
                      <tbody>
                        {tablePageAbstracts.flatMap((a, idx) => {
                          const prev = idx === 0 ? prevPageLastAbstract : tablePageAbstracts[idx - 1];
                          const showDate = tableAgendaMode && (
                            !prev || formatAgendaDate(parseStartMs(a.start)) !== formatAgendaDate(parseStartMs(prev.start))
                          );
                          const rows = [];
                          if (showDate) {
                            rows.push(
                              <tr key={`agenda-hdr-${a.internalId}-${idx}`} className="table-agenda-date">
                                <td colSpan={8}>{formatAgendaDate(parseStartMs(a.start))}</td>
                              </tr>
                            );
                          }
                          rows.push(
                            <tr key={a.id + String(a.internalId)} onClick={() => { const i = abstracts.findIndex((x) => x.id === a.id); setSelectedId(i >= 0 ? i : null); }}>
                              <td style={{ color: "#8d95a3", whiteSpace: "nowrap" }}>{a.id}</td>
                              <td style={{ whiteSpace: "nowrap", color: "#b0b8c4" }}>{a.start || "—"}</td>
                              <td style={{ whiteSpace: "nowrap", color: "#a8b0bc" }}>{a.posterNumber || "—"}</td>
                              <td style={{ color: "#e4e7ed", maxWidth: 280 }}>{a.title}</td>
                              <td style={{ maxWidth: 160 }}>{a.presenter}</td>
                              <td style={{ maxWidth: 180 }}>{a.session}</td>
                              <td style={{ color: topicColors[a.clusterTopic], maxWidth: 160 }}>{a.clusterTopic}</td>
                              <td style={{ textAlign: "center", cursor: "pointer" }} onClick={(e) => { e.stopPropagation(); toggleFavorite(a.id); }}>
                                {activeListIds.has(a.id) ? <span style={{ color: FAVORITE_POINT_COLOR }}>★</span> : <span style={{ color: "#5c6370" }}>☆</span>}
                              </td>
                            </tr>
                          );
                          return rows;
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
