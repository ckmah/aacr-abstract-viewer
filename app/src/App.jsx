import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { Canvas, useThree, useFrame, extend } from "@react-three/fiber";
import { OrbitControls, GizmoHelper, GizmoViewport, shaderMaterial, Billboard } from "@react-three/drei";
import * as THREE from "three";

const PICK_RADIUS_PX = 30;
const ZOOM_STOP_COUNT = 22;

/* ── Tableau 40 (topic / cluster colors) ── */
const PALETTE = [
  "#03579b", "#0488d1", "#03a9f4", "#4fc3f7", "#b3e5fc",
  "#253137", "#455a64", "#607d8b", "#90a4ae", "#cfd8dc",
  "#19237e", "#303f9f", "#3f51b5", "#7986cb", "#c5cae9",
  "#4a198c", "#7b21a2", "#9c27b0", "#ba68c8", "#e1bee7",
  "#88144f", "#c21f5b", "#e92663", "#f06292", "#f8bbd0",
  "#bf360c", "#e64a18", "#ff5722", "#ff8a65", "#ffccbc",
  "#f67f17", "#fbc02c", "#ffec3a", "#fff177", "#fdf9c3",
  "#33691d", "#689f38", "#8bc34a", "#aed581", "#ddedc8",
];

const FAVORITE_IDS_KEY = "aacr-favorite-ids";
const LISTS_STORAGE_KEY = "aacr-favorite-lists";
const LISTS_LEGACY_KEY = "aacr-favorites";
const FAVORITE_POINT_COLOR = "#ffd93d";
const ZOOM_MIN = 0.55;
const ZOOM_MAX = 2;

const scatterOrbitActiveRef = { current: false };
const scatterZoomActiveRef = { current: false };
/** After an orbit drag, browser still fires click; skip one scatter select. */
const scatterSuppressNextClickRef = { current: false };
const scatterOrbitPointerDownRef = { current: null };
const scatterOrbitDragExceededRef = { current: false };
const SCATTER_ORBIT_DRAG_THRESHOLD_PX = 5;

function scatterPickBlocked() {
  return scatterOrbitActiveRef.current || scatterZoomActiveRef.current;
}

function parseStartMs(s) {
  if (!s || typeof s !== "string") return 0;
  let normalized = s.trim();
  const isoDateTime = /^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}:\d{2}(?::\d{2})?)/;
  const m = isoDateTime.exec(normalized);
  if (m && !normalized.includes("T")) normalized = `${m[1]}T${m[2]}`;
  const t = Date.parse(normalized);
  return Number.isNaN(t) ? 0 : t;
}

function formatAbstractTime(ms) {
  if (!ms) return "—";
  return new Date(ms).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatAbstractTimeLabel(s) {
  const ms = parseStartMs(s);
  if (ms) return formatAbstractTime(ms);
  const t = s && String(s).trim();
  return t || "—";
}

function formatAgendaDate(ms) {
  if (!ms) return "Unknown date";
  return new Date(ms).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}

function rowTimeMs(a) {
  return parseStartMs(a.start);
}

function timeDomainFromRows(rows) {
  let minT = Infinity;
  let maxT = -Infinity;
  for (const a of rows) {
    const t = rowTimeMs(a);
    if (t > 0) {
      minT = Math.min(minT, t);
      maxT = Math.max(maxT, t);
    }
  }
  if (!isFinite(minT) || minT >= maxT) return null;
  return { min: minT, max: maxT };
}

const MS = 1;
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function pickNiceTickStep(spanMs, maxTicks = 6) {
  const ideal = spanMs / Math.max(2, maxTicks);
  const steps = [
    500 * MS, SEC, 2 * SEC, 5 * SEC, 10 * SEC, 15 * SEC, 30 * SEC,
    MIN, 2 * MIN, 5 * MIN, 10 * MIN, 15 * MIN, 30 * MIN,
    HOUR, 2 * HOUR, 3 * HOUR, 4 * HOUR, 6 * HOUR, 12 * HOUR,
    DAY, 2 * DAY, 7 * DAY, 14 * DAY, 30 * DAY, 90 * DAY, 365 * DAY,
  ];
  for (let i = 0; i < steps.length; i++) {
    if (steps[i] >= ideal) return steps[i];
  }
  return steps[steps.length - 1];
}

function formatTimelineInstant(ms, spanMs) {
  const d = new Date(ms);
  if (spanMs > 180 * DAY) {
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }
  if (spanMs > 14 * DAY) {
    return d.toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" });
  }
  if (spanMs > 2 * DAY) {
    return d.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }
  if (spanMs > 6 * HOUR) {
    return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }
  if (spanMs > 45 * MIN) {
    return d.toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });
  }
  if (spanMs > 5 * MIN) {
    return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }
  if (spanMs > 45 * SEC) {
    return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3 });
}

function formatTimelineTickInterior(ms, spanMs) {
  const d = new Date(ms);
  if (spanMs > 21 * DAY) {
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  if (spanMs > 2 * DAY) {
    return d.toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });
  }
  if (spanMs > 6 * HOUR) {
    return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }
  if (spanMs > 5 * MIN) {
    return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 2 });
}

function buildTimelineTicks(v0, v1, domainMin, domainMax, maxTicks = 6) {
  const span = v1 - v0;
  if (!Number.isFinite(span) || span <= 0) return [];
  const step = pickNiceTickStep(span, maxTicks + 1);
  const start = Math.ceil(v0 / step) * step;
  const ticks = [];
  const eps = step * 1e-7;
  for (let ms = start; ms <= v1 + eps; ms += step) {
    if (ms + eps < v0) continue;
    if (ms - eps > v1) break;
    const clamped = Math.min(Math.max(ms, domainMin), domainMax);
    const frac = (clamped - v0) / span;
    if (frac < 0.04 || frac > 0.96) continue;
    ticks.push({ ms: clamped, frac, key: `tl-${Math.round(clamped)}` });
    if (ticks.length >= maxTicks) break;
  }
  return ticks;
}

function collectEightAmMsInRange(v0, v1) {
  const out = [];
  const cur = new Date(v0);
  cur.setMilliseconds(0);
  cur.setSeconds(0);
  cur.setMinutes(0);
  cur.setHours(8);
  if (cur.getTime() < v0) cur.setDate(cur.getDate() + 1);
  while (cur.getTime() <= v1) {
    out.push(cur.getTime());
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

function buildTimelineTicksAt8am(v0, v1, domainMin, domainMax, maxTicks = 6) {
  const span = v1 - v0;
  if (!Number.isFinite(span) || span <= 0) return [];
  let raw = collectEightAmMsInRange(v0, v1);
  if (raw.length > maxTicks) raw = thinSortedTimes(raw, maxTicks);
  const ticks = [];
  for (const ms of raw) {
    const clamped = Math.min(Math.max(ms, domainMin), domainMax);
    const frac = (clamped - v0) / span;
    if (frac < 0.04 || frac > 0.96) continue;
    ticks.push({ ms: clamped, frac, key: `tl8-${Math.round(clamped)}` });
    if (ticks.length >= maxTicks) break;
  }
  return ticks;
}

function buildMainTimelineTicks(v0, v1, domainMin, domainMax, maxTicks = 6) {
  let t = buildTimelineTicksAt8am(v0, v1, domainMin, domainMax, maxTicks);
  if (t.length === 0) t = buildTimelineTicks(v0, v1, domainMin, domainMax, maxTicks);
  return t;
}

function classifyTimelineMarkKind(ms) {
  const s = Math.round(ms / 1000) * 1000;
  const d = new Date(s);
  if (d.getHours() === 8 && d.getMinutes() === 0 && d.getSeconds() === 0) return "day";
  if (d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0) return "day";
  if (d.getMinutes() === 0 && d.getSeconds() === 0) return "hour";
  return "sub";
}

function buildTimelineVerticalMarks(v0, v1, domainMin, domainMax) {
  const interior = buildMainTimelineTicks(v0, v1, domainMin, domainMax, 6);
  const rows = [
    { frac: 0, key: "mark-v0", ms: v0 },
    ...interior.map((t) => ({ frac: t.frac, key: `mark-${t.key}`, ms: t.ms })),
    { frac: 1, key: "mark-v1", ms: v1 },
  ];
  return rows.map((r) => ({ ...r, kind: classifyTimelineMarkKind(r.ms) }));
}

function binSegmentInView(binStart, binEnd, v0, v1) {
  const lo = Math.max(v0, binStart);
  const hi = Math.min(v1, binEnd);
  if (hi <= lo) return null;
  const span = v1 - v0;
  return { left: (lo - v0) / span, width: (hi - lo) / span };
}

function buildHourlyHeatmapStats(abstracts, domain) {
  if (!domain || !abstracts?.length) return null;
  const { min, max } = domain;
  const bin0 = Math.floor(min / HOUR) * HOUR;
  const numBins = Math.max(1, Math.ceil((max - bin0) / HOUR));
  const counts = new Array(numBins).fill(0);
  for (const a of abstracts) {
    const t = rowTimeMs(a);
    if (!t || t < min || t > max) continue;
    const i = Math.min(numBins - 1, Math.max(0, Math.floor((t - bin0) / HOUR)));
    counts[i]++;
  }
  const maxCount = Math.max(1, ...counts);
  const bins = counts.map((count, i) => ({
    start: bin0 + i * HOUR,
    end: bin0 + (i + 1) * HOUR,
    count,
  }));
  return { bins, maxCount };
}

function thinSortedTimes(sorted, max) {
  if (sorted.length <= max) return sorted;
  const out = [];
  const n = sorted.length;
  const step = (n - 1) / (max - 1);
  for (let k = 0; k < max; k++) out.push(sorted[Math.round(k * step)]);
  return [...new Set(out)].sort((a, b) => a - b);
}

function uniqueSortedMarkerTimes(rows, max = 1200) {
  const s = new Set();
  for (const a of rows) {
    const t = rowTimeMs(a);
    if (t > 0) s.add(t);
  }
  const arr = [...s].sort((a, b) => a - b);
  return thinSortedTimes(arr, max);
}

const TL_MIN_ZOOM_WINDOW_MS = 3 * HOUR;

function formatDurationShort(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "0";
  if (ms >= DAY) return `${(ms / DAY).toFixed(ms >= 10 * DAY ? 0 : 1)}d`;
  if (ms >= HOUR) return `${Math.round(ms / HOUR)}h`;
  if (ms >= MIN) return `${Math.round(ms / MIN)}m`;
  return `${Math.round(ms / SEC)}s`;
}

function TableTimeFilterBar({
  domain,
  viewMin,
  viewMax,
  filterMin,
  filterMax,
  onViewChange,
  onFilterChange,
  onClearFilter,
  heatmapStats,
  occurrenceMarkerTimes,
  selectedTimeMs,
}) {
  const trackRef = useRef(null);
  const timelineMapRef = useRef(null);
  const drag = useRef(null);
  const [hoverHint, setHoverHint] = useState(null);
  const [rangePreview, setRangePreview] = useState(null);

  const v0 = viewMin;
  const v1 = viewMax;
  const domainSpan = domain.max - domain.min;
  const minZoomSpan = Math.min(TL_MIN_ZOOM_WINDOW_MS, Math.max(domainSpan, MIN));
  const viewSpan = Math.max(v1 - v0, minZoomSpan);

  const msToFrac = (ms) => (ms - v0) / viewSpan;

  const clampPairToView = (a, b) => {
    let lo = Math.min(a, b);
    let hi = Math.max(a, b);
    lo = Math.max(lo, v0);
    hi = Math.min(hi, v1);
    if (hi - lo < 60000) hi = lo + 60000;
    if (hi > v1) {
      hi = v1;
      lo = Math.max(v0, hi - 60000);
    }
    return { min: lo, max: hi };
  };

  const clientXToMs = (clientX) => {
    const el = timelineMapRef.current || trackRef.current;
    if (!el) return v0;
    const rect = el.getBoundingClientRect();
    const mx = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return v0 + mx * viewSpan;
  };

  const trackCursorStyle = (clientX) => {
    if (!timelineMapRef.current && !trackRef.current) return "crosshair";
    const ms = clientXToMs(clientX);
    const fl = msToFrac(filterMin);
    const fr = msToFrac(filterMax);
    const brushFracW = Math.max(fr - fl, 0);
    const atFullDomain =
      filterMin <= domain.min + 1000 && filterMax >= domain.max - 1000;
    const canMoveBrush =
      !atFullDomain && brushFracW < 0.94 && brushFracW > 0.012;
    const inBrush = canMoveBrush && ms >= filterMin && ms <= filterMax;
    if (inBrush) return "grab";
    return "crosshair";
  };

  const onPointerMove = (e) => {
    const d = drag.current;
    if (d && trackRef.current) {
      const c =
        d.mode === "move" || d.mode === "pan" ? "grabbing" : "crosshair";
      trackRef.current.style.cursor = c;
    }
    if (!d || !trackRef.current) return;
    const rect = trackRef.current.getBoundingClientRect();
    const w = rect.width;
    const totalDx = e.clientX - d.pointerDownX;
    const dMs = (totalDx / w) * (d.initialV1 - d.initialV0);

    if (d.mode === "pan") {
      const span = d.initialV1 - d.initialV0;
      let n0 = d.initialV0 - dMs;
      let n1 = d.initialV1 - dMs;
      if (n0 < d.domain.min) {
        n0 = d.domain.min;
        n1 = n0 + span;
      }
      if (n1 > d.domain.max) {
        n1 = d.domain.max;
        n0 = n1 - span;
      }
      onViewChange({ min: n0, max: n1 });
      return;
    }
    if (d.mode === "move") {
      const span = d.initialF1 - d.initialF0;
      let a = d.initialF0 + dMs;
      let b = a + span;
      if (a < v0) {
        a = v0;
        b = a + span;
      }
      if (b > v1) {
        b = v1;
        a = b - span;
      }
      onFilterChange({ min: a, max: b }, { reason: "move" });
      return;
    }
    if (d.mode === "selectRange") {
      const cur = clientXToMs(e.clientX);
      const next = clampPairToView(d.anchorMs, cur);
      d.preview = next;
      setRangePreview(next);
      setHoverHint({
        x: e.clientX,
        y: e.clientY,
        text: formatTimelineInstant(cur, viewSpan),
      });
    }
  };

  const onPointerUp = (e) => {
    const d = drag.current;
    const el = trackRef.current;
    if (el && e.pointerId != null) {
      try {
        el.releasePointerCapture(e.pointerId);
      } catch { /* ignore */ }
    }
    if (d?.mode === "selectRange" && d.preview) {
      onFilterChange(d.preview, { reason: "selectCommit" });
    }
    drag.current = null;
    setRangePreview(null);
    setHoverHint(null);
    if (trackRef.current) trackRef.current.style.cursor = "";
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerUp);
  };

  const onPointerDown = (e) => {
    if (!trackRef.current || e.button !== 0) return;
    const el = trackRef.current;
    const ms = clientXToMs(e.clientX);
    const fl = msToFrac(filterMin);
    const fr = msToFrac(filterMax);
    const brushFracW = Math.max(fr - fl, 0);
    const atFullDomain =
      filterMin <= domain.min + 1000 && filterMax >= domain.max - 1000;
    const canMoveBrush =
      !atFullDomain && brushFracW < 0.94 && brushFracW > 0.012;
    const inBrush = canMoveBrush && ms >= filterMin && ms <= filterMax;

    setHoverHint(null);
    if (e.shiftKey) {
      el.style.cursor = "grabbing";
      drag.current = {
        mode: "pan",
        pointerDownX: e.clientX,
        initialV0: v0,
        initialV1: v1,
        initialF0: filterMin,
        initialF1: filterMax,
        domain,
      };
    } else if (inBrush) {
      el.style.cursor = "grabbing";
      drag.current = {
        mode: "move",
        pointerDownX: e.clientX,
        initialV0: v0,
        initialV1: v1,
        initialF0: filterMin,
        initialF1: filterMax,
        domain,
      };
    } else {
      el.style.cursor = "crosshair";
      const seed = clampPairToView(ms, ms);
      setRangePreview(seed);
      drag.current = {
        mode: "selectRange",
        pointerDownX: e.clientX,
        anchorMs: ms,
        preview: seed,
        initialV0: v0,
        initialV1: v1,
        initialF0: filterMin,
        initialF1: filterMax,
        domain,
      };
    }
    try {
      el.setPointerCapture(e.pointerId);
    } catch { /* ignore */ }
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
  };

  const onTimelineMapPointerMove = (e) => {
    if (drag.current) return;
    const ms = clientXToMs(e.clientX);
    setHoverHint({
      x: e.clientX,
      y: e.clientY,
      text: formatTimelineInstant(ms, viewSpan),
    });
    if (trackRef.current) trackRef.current.style.cursor = trackCursorStyle(e.clientX);
  };

  const onTimelineMapPointerLeave = () => {
    if (!drag.current) {
      setHoverHint(null);
      if (trackRef.current) trackRef.current.style.cursor = "";
    }
  };

  useEffect(() => {
    const el = trackRef.current;
    if (!domain || !el) return;
    const handler = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const rect = el.getBoundingClientRect();
      const mx = (e.clientX - rect.left) / rect.width;
      const cursorMs = v0 + Math.min(1, Math.max(0, mx)) * viewSpan;
      const span = viewSpan;
      const factor = e.deltaY > 0 ? 1.12 : 1 / 1.12;
      let newSpan = Math.max(minZoomSpan, span * factor);
      newSpan = Math.min(newSpan, domain.max - domain.min);
      let n0 = cursorMs - mx * newSpan;
      let n1 = n0 + newSpan;
      if (n0 < domain.min) {
        n0 = domain.min;
        n1 = n0 + newSpan;
      }
      if (n1 > domain.max) {
        n1 = domain.max;
        n0 = n1 - newSpan;
      }
      onViewChange({ min: n0, max: n1 });
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, [domain, v0, v1, viewSpan, minZoomSpan, onViewChange]);

  if (!domain) return null;

  const fullSpan = domain.max - domain.min;
  const zoomPct = fullSpan > 0 ? Math.round((viewSpan / fullSpan) * 1000) / 10 : 100;

  const dispMin = rangePreview ? rangePreview.min : filterMin;
  const dispMax = rangePreview ? rangePreview.max : filterMax;
  const fl = Math.min(1, Math.max(0, msToFrac(dispMin)));
  const fr = Math.min(1, Math.max(0, msToFrac(dispMax)));
  const fw = Math.max(fr - fl, 0.012);
  const atFullDomain =
    filterMin <= domain.min + 1000 && filterMax >= domain.max - 1000;

  return (
    <div className="table-time-filter">
      <div className="table-time-filter-label">
        <span>Time range</span>
        {!atFullDomain ? (
          <button type="button" className="ctrl-btn table-time-clear" onClick={onClearFilter}>
            Reset range
          </button>
        ) : null}
      </div>
      <div className="table-time-filter-axis">
        <div className="table-time-zoom-legend" title="Viewport width vs full agenda span">
          <span>{zoomPct}% of agenda</span>
          <span className="table-time-zoom-legend-sub">{formatDurationShort(viewSpan)} window</span>
        </div>
        <div className="table-time-filter-vrules" aria-hidden>
          {buildTimelineVerticalMarks(v0, v1, domain.min, domain.max).map((m) => (
            <div
              key={m.key}
              className={`table-time-filter-vrule table-time-filter-vrule--${m.kind}`}
              style={{ left: `${m.frac * 100}%` }}
            />
          ))}
        </div>
        <div
          className="table-time-filter-map-surface"
          ref={timelineMapRef}
          onPointerMove={onTimelineMapPointerMove}
          onPointerLeave={onTimelineMapPointerLeave}
        >
        <div
          className="table-time-filter-tickstrip"
          aria-hidden
        >
          {buildMainTimelineTicks(v0, v1, domain.min, domain.max, 6).map((t) => (
            <span
              key={t.key}
              className="table-time-filter-tick"
              style={{ left: `${t.frac * 100}%` }}
              title={formatTimelineInstant(t.ms, viewSpan)}
            >
              {formatTimelineTickInterior(t.ms, viewSpan)}
            </span>
          ))}
        </div>
        <div
          className="table-time-filter-track"
          ref={trackRef}
          onPointerDown={onPointerDown}
          role="slider"
          aria-label="Time range filter and zoom"
        >
          {heatmapStats ? (
            <div className="table-time-filter-heatmap-wrap" aria-hidden>
              {heatmapStats.bins.map((bin) => {
                const seg = binSegmentInView(bin.start, bin.end, v0, v1);
                if (!seg) return null;
                const intensity = bin.count / heatmapStats.maxCount;
                return (
                  <div
                    key={`heat-${bin.start}`}
                    className="table-time-filter-heatcell"
                    style={{
                      left: `${seg.left * 100}%`,
                      width: `${seg.width * 100}%`,
                      background: `hsla(205, 72%, ${22 + 42 * intensity}%, ${0.28 + 0.52 * intensity})`,
                    }}
                    title={`${bin.count} in this hour`}
                  />
                );
              })}
            </div>
          ) : null}
          <div className="table-time-filter-occ-layer" aria-hidden>
            {(occurrenceMarkerTimes ?? []).map((ms, i) => {
              const frac = (ms - v0) / viewSpan;
              if (frac < -0.002 || frac > 1.002) return null;
              const isSel = selectedTimeMs != null && Math.abs(ms - selectedTimeMs) < 45000;
              if (isSel) return null;
              return (
                <div
                  key={`occ-flt-${ms}-${i}`}
                  className="table-time-filter-occ"
                  style={{ left: `${Math.min(1, Math.max(0, frac)) * 100}%` }}
                />
              );
            })}
            {selectedTimeMs != null && (() => {
              const frac = (selectedTimeMs - v0) / viewSpan;
              if (frac < -0.002 || frac > 1.002) return null;
              return (
                <div
                  className="table-time-filter-occ table-time-filter-occ--selected"
                  style={{ left: `${Math.min(1, Math.max(0, frac)) * 100}%` }}
                />
              );
            })()}
          </div>
          <div
            className={`table-time-filter-brush${rangePreview ? " table-time-filter-brush--preview" : ""}`}
            style={{ left: `${fl * 100}%`, width: `${fw * 100}%` }}
          />
        </div>
      <div className="table-time-filter-ticks">
        <span className="table-time-edge">{formatTimelineInstant(v0, viewSpan)}</span>
        <span className="table-time-filter-hint">Wheel zoom · Shift+drag pan · drag to set range · drag band to move</span>
        <span className="table-time-edge">{formatTimelineInstant(v1, viewSpan)}</span>
      </div>
        </div>
      </div>
      {typeof document !== "undefined" && hoverHint
        ? createPortal(
            <div
              className="table-time-cursor-hint"
              style={{
                position: "fixed",
                left: hoverHint.x + 8,
                top: hoverHint.y + 8,
                zIndex: 10050,
              }}
            >
              {hoverHint.text}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

function compareTableRows(a, b, key, dir, favoriteIdSet) {
  const m = dir === "asc" ? 1 : -1;
  const lc = (x) => String(x ?? "").toLowerCase();
  switch (key) {
    case "id":
      return m * lc(a.id).localeCompare(lc(b.id));
    case "type":
      return m * lc(a.type || "poster").localeCompare(lc(b.type || "poster"));
    case "time":
      return m * (rowTimeMs(a) - rowTimeMs(b));
    case "poster":
      return m * lc(a.posterNumber).localeCompare(lc(b.posterNumber));
    case "title":
      return m * lc(a.title).localeCompare(lc(b.title));
    case "presenter":
      return m * lc(unifiedPeopleText(a.authors, a.presenter)).localeCompare(
        lc(unifiedPeopleText(b.authors, b.presenter)),
      );
    case "session":
      return m * lc(a.session).localeCompare(lc(b.session));
    case "topic":
      return m * lc(a.clusterTopic).localeCompare(lc(b.clusterTopic));
    case "fav":
      return m * ((favoriteIdSet.has(a.id) ? 1 : 0) - (favoriteIdSet.has(b.id) ? 1 : 0));
    default:
      return 0;
  }
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

function normalizePersonKey(s) {
  return String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Posters use `authors`, talks use `presenter` for the same role; merge without duplicates. */
function unifiedPeopleList(authors, presenter) {
  const seen = new Set();
  const out = [];
  const add = (raw) => {
    const t = String(raw || "").trim();
    if (!t) return;
    const k = normalizePersonKey(t);
    if (seen.has(k)) return;
    seen.add(k);
    out.push(t);
  };
  for (const a of authors || []) add(a);
  add(presenter);
  return out;
}

function unifiedPeopleText(authors, presenter) {
  const list = unifiedPeopleList(authors, presenter);
  return list.length ? list.join(", ") : "—";
}

function AffiliationView({ institution, authors, presenter }) {
  const presenterTrim = (presenter || "").trim();
  const { authorParts, affiliationLines } = parseInstitutionBlock(institution);
  const hasParsedAffil = affiliationLines.length > 0;
  const hasAuthorSup = authorParts.some((p) => p.sup);
  const presenterDupInParts =
    presenterTrim &&
    authorParts.some((p) => normalizePersonKey(p.text) === normalizePersonKey(presenterTrim));
  if (!hasParsedAffil && !hasAuthorSup) {
    return (
      <>
        <div className="detail-meta"><b>Authors</b> {unifiedPeopleText(authors, presenter)}</div>
        {institution ? <div className="detail-meta"><b>Institution:</b> {institution}</div> : null}
      </>
    );
  }
  return (
    <>
      <div className="detail-meta">
        <b>Authors</b>{" "}
        {presenterTrim && !presenterDupInParts ? <span>{presenterTrim}. </span> : null}
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

function isSemanticMapPoint(a) {
  return a && a.includeInSemanticMap !== false;
}

function abstractMatchesSearch(a, term) {
  if (!term) return true;
  const t = term.toLowerCase();
  const parts = [
    a.title,
    unifiedPeopleList(a.authors, a.presenter).join(" "),
    String(a.id),
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
  attribute float aIndex;
  varying vec3 vColor;
  varying float vDistance;
  varying float vSel;
  uniform float uRadius;
  uniform float uSelIndex;

  void main() {
    vColor = color;
    float isS = (uSelIndex >= 0.0 && abs(aIndex - uSelIndex) < 0.5) ? 1.0 : 0.0;
    vSel = isS;

    float distanceFactor = pow(max(0.0, uRadius - distance(position, vec3(0.0))), 1.5);
    float size = distanceFactor * 3.2 + 3.8;
    size *= 1.0 + 0.22 * vSel;
    vDistance = distanceFactor;

    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;

    gl_PointSize = size;
    gl_PointSize *= (1.0 / max(-mvPosition.z, 1e-4));
    gl_PointSize = clamp(gl_PointSize, 2.0, 72.0);
  }
`;

const POINT_SPRITE_FRAG = `
  varying vec3 vColor;
  varying float vDistance;
  varying float vSel;
  uniform vec3 uWarmTint;
  uniform float uIntensity;

  void main() {
    float r = distance(gl_PointCoord, vec2(0.5)) * 2.0;

    float strength = pow(max(1.0 - smoothstep(0.48, 1.0, r), 0.0), 1.25);
    vec3 color = vColor;
    float warmAmt = clamp(vDistance * 0.042, 0.0, 0.11);
    color = mix(color, uWarmTint, warmAmt);
    float selBoost = vSel;
    color *= uIntensity * (1.0 + 0.28 * selBoost);
    float alpha = strength * 0.52 * (1.0 + 0.14 * selBoost);
    if (alpha < 0.018) discard;
    color = min(color * strength, vec3(1.25));
    gl_FragColor = vec4(color, alpha);
  }
`;

const PointSpriteMaterial = shaderMaterial(
  {
    uRadius: 1.5,
    uWarmTint: new THREE.Vector3(0.88, 0.78, 0.72),
    uIntensity: 0.88,
    uSelIndex: -1,
  },
  POINT_SPRITE_VERT,
  POINT_SPRITE_FRAG,
  (m) => {
    m.glslVersion = THREE.GLSL1;
    m.transparent = true;
    m.depthTest = true;
    m.depthWrite = false;
    m.blending = THREE.NormalBlending;
    m.vertexColors = true;
  },
);
extend({ PointSpriteMaterial });

function SelectionRing({ position }) {
  const groupRef = useRef(null);
  useFrame(({ clock }) => {
    const g = groupRef.current;
    if (!g) return;
    const s = 1 + 0.1 * Math.sin(clock.elapsedTime * 2.75);
    g.scale.setScalar(s);
  });
  return (
    <Billboard follow position={position}>
      <group ref={groupRef}>
        <mesh renderOrder={1000} frustumCulled={false}>
          <ringGeometry args={[0.0066, 0.0104, 48]} />
          <meshBasicMaterial
            color="#ffffff"
            transparent
            opacity={0.2}
            side={THREE.DoubleSide}
            depthTest
            depthWrite={false}
          />
        </mesh>
        <mesh renderOrder={1001} frustumCulled={false}>
          <ringGeometry args={[0.0048, 0.0078, 48]} />
          <meshBasicMaterial
            color="#ffffff"
            transparent
            opacity={0.55}
            side={THREE.DoubleSide}
            depthTest
            depthWrite={false}
          />
        </mesh>
      </group>
    </Billboard>
  );
}

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
  abstracts, embeddings, filteredSet, pickIndices, searchSimilarity,
  clusterColors, topicColors, topicFilterSelected, selectedId, onSelect,
  listVisuals,
}) {
  const geomRef = useRef();
  const { camera, gl } = useThree();
  const N = embeddings.length;
  const vProj = useRef(new THREE.Vector3());

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
      if (!isSemanticMapPoint(abstracts[i])) {
        arr[i * 3] = arr[i * 3 + 1] = arr[i * 3 + 2] = 0;
        continue;
      }
      const topic = abstracts[i].clusterTopic || "Unknown";
      let hex = !filteredSet.has(i) ? "#121212"
        : searchSimilarity ? similarityColor(searchSimilarity[i])
        : topicFilterOn
          ? (topicColors[topic] || "#9ea4ad")
          : (clusterColors[abstracts[i].cluster] || "#9ea4ad");
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
      arr[i * 3]     = c.r;
      arr[i * 3 + 1] = c.g;
      arr[i * 3 + 2] = c.b;
    }
    return arr;
  }, [abstracts, N, filteredSet, searchSimilarity, clusterColors, topicColors, topicFilterSelected, listVisuals]);

  useEffect(() => {
    if (!geomRef.current || N === 0) return;
    geomRef.current.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const colAttr = new THREE.BufferAttribute(baseColors.slice(), 3);
    colAttr.setUsage(THREE.DynamicDrawUsage);
    geomRef.current.setAttribute("color", colAttr);
    const idx = new Float32Array(N);
    for (let i = 0; i < N; i++) idx[i] = i;
    geomRef.current.setAttribute("aIndex", new THREE.BufferAttribute(idx, 1));
    geomRef.current.computeBoundingSphere();
  }, [positions, baseColors, N]);

  useEffect(() => {
    const el = gl.domElement;
    const onPointerMove = (e) => {
      if (scatterOrbitActiveRef.current) {
        const p0 = scatterOrbitPointerDownRef.current;
        if (
          p0 &&
          Math.hypot(e.clientX - p0.x, e.clientY - p0.y) > SCATTER_ORBIT_DRAG_THRESHOLD_PX
        ) {
          scatterOrbitDragExceededRef.current = true;
        }
      }
    };
    const onPointerDown = (e) => {
      scatterOrbitPointerDownRef.current = { x: e.clientX, y: e.clientY };
      scatterOrbitDragExceededRef.current = false;
    };
    const onClick = (e) => {
      if (scatterSuppressNextClickRef.current) {
        scatterSuppressNextClickRef.current = false;
        return;
      }
      if (scatterPickBlocked()) return;
      const rect = el.getBoundingClientRect();
      const i = pickNearestScreenIndex(e.clientX, e.clientY, rect, camera, positions, pickIndices, vProj.current);
      onSelect(i);
    };
    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("click", onClick);
    return () => {
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("click", onClick);
    };
  }, [gl, camera, positions, pickIndices, onSelect]);

  const selectionPosition = useMemo(() => {
    if (selectedId === null || !isSemanticMapPoint(abstracts[selectedId])) return null;
    const e = embeddings[selectedId];
    return [e.x - 0.5, e.y - 0.5, (e.z ?? 0) - 0.5];
  }, [selectedId, embeddings, abstracts]);

  return (
    <>
      <points raycast={() => null}>
        <bufferGeometry ref={geomRef} />
        <pointSpriteMaterial
          uSelIndex={selectedId !== null && selectedId !== undefined ? selectedId : -1}
        />
      </points>
      {selectionPosition ? <SelectionRing position={selectionPosition} /> : null}
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
      scatterZoomActiveRef.current = true;
      const len = targetRef.current ?? camera.position.length();
      const i = nearestZoomStopIndex(len, stops);
      const next = e.deltaY > 0 ? Math.min(stops.length - 1, i + 1) : Math.max(0, i - 1);
      targetRef.current = stops[next];
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [gl, camera, stops]);

  useFrame(() => {
    if (targetRef.current === null) {
      scatterZoomActiveRef.current = false;
      return;
    }
    const cur = camera.position.length();
    const next = cur + (targetRef.current - cur) * 0.075;
    if (Math.abs(next - targetRef.current) < 0.001) {
      camera.position.setLength(targetRef.current);
      targetRef.current = null;
      scatterZoomActiveRef.current = false;
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

  const [selectedId, setSelectedId] = useState(null);
  const [favoriteIds, setFavoriteIds] = useState(() => loadFavoriteIds());
  const [searchTerm, setSearchTerm] = useState("");
  const [topicFilterSelected, setTopicFilterSelected] = useState(() => new Set());
  const [sessionFilterSelected, setSessionFilterSelected] = useState(() => new Set());
  const [typeFilter, setTypeFilter] = useState(null); // null = all, "poster", "talk"
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
  const [tableHeight, setTableHeight] = useState(350);
  const TABLE_INITIAL_VISIBLE = 80;
  const TABLE_SCROLL_CHUNK = 100;
  const [tableVisibleCount, setTableVisibleCount] = useState(TABLE_INITIAL_VISIBLE);
  const tableBodyRef = useRef(null);
  const [autoRotate, setAutoRotate] = useState(false);
  const [tlView, setTlView] = useState({ min: 0, max: 1 });
  const [tlFilter, setTlFilter] = useState({ min: 0, max: 1 });
  const [sortCol, setSortCol] = useState("time");
  const [sortDir, setSortDir] = useState("asc");

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
  }, []);

  const toggleSessionFilter = useCallback((sess) => {
    setSessionFilterSelected((prev) => {
      const n = new Set(prev);
      if (n.has(sess)) n.delete(sess);
      else n.add(sess);
      return n;
    });
  }, []);

  const clearTopicFilters = useCallback(() => {
    setTopicFilterSelected(new Set());
  }, []);

  const clearSessionFilters = useCallback(() => {
    setSessionFilterSelected(new Set());
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


  // Search similarity: 3D centroid distance (semantic-map points only; agenda rows stay unlit)
  const searchSimilarity = useMemo(() => {
    if (!searchTerm || searchTerm.length < 2 || embeddings.length === 0) return null;
    const term = searchTerm.trim();
    const matches = [];
    abstracts.forEach((a, i) => {
      if (!isSemanticMapPoint(a) || !abstractMatchesSearch(a, term)) return;
      matches.push(i);
    });
    if (matches.length === 0) return null;
    let cx = 0, cy = 0, cz = 0;
    matches.forEach((i) => { cx += embeddings[i].x; cy += embeddings[i].y; cz += embeddings[i].z; });
    cx /= matches.length; cy /= matches.length; cz /= matches.length;
    const dists = embeddings.map((e, i) => (
      isSemanticMapPoint(abstracts[i])
        ? Math.hypot(e.x - cx, e.y - cy, e.z - cz)
        : 0
    ));
    const maxDist = Math.max(...dists) || 1;
    return dists.map((d, i) => (
      isSemanticMapPoint(abstracts[i]) ? 1 - d / maxDist : 0
    ));
  }, [searchTerm, abstracts, embeddings]);

  // Filtered abstracts
  const filteredIndices = useMemo(() => {
    const term = searchTerm.trim();
    return abstracts.map((_, i) => i).filter((i) => {
      const a = abstracts[i];
      if (showFavoritesOnly && !activeListIds.has(a.id)) return false;
      if (topicFilterSelected.size > 0 && !topicFilterSelected.has(a.clusterTopic || "Unknown")) return false;
      if (sessionFilterSelected.size > 0 && !sessionFilterSelected.has(a.session)) return false;
      if (typeFilter && (a.type || "poster") !== typeFilter) return false;
      if (term && !abstractMatchesSearch(a, term)) return false;
      return true;
    });
  }, [abstracts, searchTerm, topicFilterSelected, sessionFilterSelected, typeFilter, showFavoritesOnly, activeListIds]);

  const filteredSet = useMemo(() => new Set(filteredIndices), [filteredIndices]);

  const mapPickIndices = useMemo(
    () => filteredIndices.filter((i) => isSemanticMapPoint(abstracts[i])),
    [filteredIndices, abstracts],
  );

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
    const header = "ID,Type,Title,Authors,Institution,Session,Time,Topic,Poster Number,Abstract";
    const rows = items.map((a) =>
      [a.id, a.type || "poster", a.title, unifiedPeopleText(a.authors, a.presenter), a.institution, a.session, a.start || "", a.clusterTopic, a.posterNumber, a.abstract.replace(/\n/g, " ")].map(escape).join(",")
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
  const timeDomain = useMemo(() => timeDomainFromRows(abstracts), [abstracts]);
  const heatmapStats = useMemo(() => buildHourlyHeatmapStats(abstracts, timeDomain), [abstracts, timeDomain]);
  const occurrenceMarkerTimes = useMemo(() => uniqueSortedMarkerTimes(tableData, 1200), [tableData]);
  const selectedTimeMsForTimeline = useMemo(() => {
    if (selectedId == null || !abstracts[selectedId]) return null;
    const t = rowTimeMs(abstracts[selectedId]);
    return t > 0 ? t : null;
  }, [selectedId, abstracts]);

  useEffect(() => {
    if (!timeDomain) return;
    setTlView({ min: timeDomain.min, max: timeDomain.max });
    setTlFilter({ min: timeDomain.min, max: timeDomain.max });
  }, [timeDomain?.min, timeDomain?.max]);

  const handleTimelineFilterChange = useCallback(
    (range, meta) => {
      setTlFilter(range);
      if (meta?.reason !== "selectCommit" || !timeDomain) return;
      const d0 = timeDomain.min;
      const d1 = timeDomain.max;
      const a = range.min;
      const b = range.max;
      const span = Math.max(b - a, MIN);
      const pad = Math.max(span * 0.04, 2 * MIN);
      let v0 = Math.max(d0, a - pad);
      let v1 = Math.min(d1, b + pad);
      let win = v1 - v0;
      const domainW = d1 - d0;
      const minWin = Math.min(TL_MIN_ZOOM_WINDOW_MS, domainW);
      if (win < minWin) {
        const mid = (a + b) / 2;
        v0 = Math.max(d0, mid - minWin / 2);
        v1 = Math.min(d1, mid + minWin / 2);
        if (v1 - v0 < minWin) {
          v0 = d0;
          v1 = d1;
        }
      }
      setTlView({ min: v0, max: v1 });
    },
    [timeDomain],
  );

  useEffect(() => {
    if (sortCol === "id" || sortCol === "presenter") {
      setSortCol("time");
      setSortDir("asc");
    }
  }, [sortCol]);

  const toggleTableSort = useCallback((col) => {
    if (col === sortCol) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortCol(col);
      setSortDir("asc");
    }
  }, [sortCol]);

  const timeFilteredTableData = useMemo(() => {
    if (!timeDomain) return tableData;
    const fMin = tlFilter.min;
    const fMax = tlFilter.max;
    const atFull = fMin <= timeDomain.min + 1000 && fMax >= timeDomain.max - 1000;
    return tableData.filter((a) => {
      const t = rowTimeMs(a);
      if (!t) return atFull;
      return t >= fMin && t <= fMax;
    });
  }, [tableData, timeDomain, tlFilter]);

  const sortedTableAbstracts = useMemo(() => {
    const r = [...timeFilteredTableData];
    r.sort((a, b) => compareTableRows(a, b, sortCol, sortDir, activeListIds));
    return r;
  }, [timeFilteredTableData, sortCol, sortDir, activeListIds]);

  const visibleTableAbstracts = useMemo(
    () => sortedTableAbstracts.slice(0, Math.min(tableVisibleCount, sortedTableAbstracts.length)),
    [sortedTableAbstracts, tableVisibleCount],
  );

  useEffect(() => {
    setTableVisibleCount(TABLE_INITIAL_VISIBLE);
    if (tableBodyRef.current) tableBodyRef.current.scrollTop = 0;
  }, [
    searchTerm,
    topicFilterSelected,
    sessionFilterSelected,
    typeFilter,
    showFavoritesOnly,
    tlFilter.min,
    tlFilter.max,
    sortCol,
    sortDir,
  ]);

  const onTableBodyScroll = useCallback(
    (e) => {
      const el = e.currentTarget;
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 120) {
        setTableVisibleCount((c) => Math.min(c + TABLE_SCROLL_CHUNK, sortedTableAbstracts.length));
      }
    },
    [sortedTableAbstracts.length, TABLE_SCROLL_CHUNK],
  );

  if (loading) {
    return (
      <div style={{ width: "100vw", height: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: "#080808", color: "#8a919c", fontFamily: "'JetBrains Mono', 'Fira Code', monospace" }}>
        <style>{`@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500&family=DM+Sans:wght@400;500;600;700&display=swap'); @keyframes pulse { 0%,100% { opacity: 0.3; } 50% { opacity: 1; } }`}</style>
        <div style={{ fontSize: 16, letterSpacing: 6, textTransform: "uppercase", marginBottom: 36, color: "#d4d4d8", animation: "pulse 2s infinite" }}>AACR 2026 Explorer</div>
        <div style={{ fontSize: 18, color: "#c8cdd6" }}>{loadingStatus}</div>
      </div>
    );
  }

  return (
    <div style={{ width: "100vw", height: "100vh", overflow: "hidden", background: "#080808", color: "#e8eaef", fontFamily: "'JetBrains Mono', 'Fira Code', monospace", position: "relative" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500&family=DM+Sans:ital,wght@0,400;0,500;0,600;0,700;1,400&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { width: 8px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.12); border-radius: 4px; }
        .top-bar { position: fixed; top: 0; left: 0; right: 0; height: ${TOP_BAR_PX}px; z-index: 50; display: flex; align-items: center; gap: 10px; padding: 0 12px 0 8px; background: rgba(14,14,15,0.97); backdrop-filter: blur(14px); border-bottom: 1px solid rgba(255,255,255,0.1); }
        .sidebar-toggle { flex-shrink: 0; width: 40px; height: 36px; display: flex; align-items: center; justify-content: center; border: 1px solid rgba(255,255,255,0.12); border-radius: 4px; background: rgba(255,255,255,0.06); color: #a0a6b4; cursor: pointer; font-size: 18px; transition: all 0.15s; }
        .sidebar-toggle:hover { border-color: rgba(212,212,216,0.34); color: #d4d4d8; }
        .top-bar .logo { font-family: 'DM Sans', sans-serif; font-weight: 700; font-size: 16px; color: #d4d4d8; letter-spacing: 3px; text-transform: uppercase; white-space: nowrap; user-select: none; flex-shrink: 0; }
        .top-bar .logo span { color: #7d8594; font-weight: 400; }
        .top-bar-search:focus { border-color: rgba(212,212,216,0.38); }
        .top-bar-search::placeholder { color: #7d8594; }
        .top-bar-tools { display: flex; align-items: center; gap: 6px; flex-shrink: 0; margin-left: auto; }
        .top-bar-search { flex: 1; min-width: 120px; max-width: 520px; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.12); color: #e4e7ed; font-family: 'JetBrains Mono', monospace; font-size: 13px; padding: 7px 12px; border-radius: 4px; outline: none; transition: border-color 0.2s; }
        .type-filter-wrap { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
        .filter-dropdown-wrap { display: flex; align-items: center; gap: 8px; flex-shrink: 0; position: relative; z-index: 55; }
        .filter-dropdown-panel { position: absolute; top: calc(100% + 8px); left: 0; min-width: 300px; max-width: min(420px, calc(100vw - 24px)); max-height: min(72vh, 520px); z-index: 60; display: flex; flex-direction: column; padding: 10px 12px; background: rgba(20,20,21,0.98); border: 1px solid rgba(255,255,255,0.14); border-radius: 6px; box-shadow: 0 12px 40px rgba(0,0,0,0.35); transform-origin: top left; animation: paneDropIn 0.24s cubic-bezier(0.22, 1, 0.36, 1) both; }
        .filter-dropdown-wrap > div:nth-child(2) .filter-dropdown-panel { left: auto; right: 0; transform-origin: top right; }
        .filter-check-list { overflow-y: auto; flex: 1; min-height: 0; margin-top: 8px; max-height: 280px; border: 1px solid rgba(255,255,255,0.08); border-radius: 4px; padding: 4px 0; background: rgba(0,0,0,0.12); }
        .filter-check-row { display: flex; align-items: flex-start; gap: 8px; padding: 6px 10px; font-size: 12px; color: #c4cad4; cursor: pointer; }
        .filter-check-row:hover { background: rgba(212,212,216,0.065); }
        .filter-check-row input { margin-top: 2px; accent-color: #d4d4d8; flex-shrink: 0; }
        .filter-check-label { flex: 1; line-height: 1.4; min-width: 0; }
        .app-main { position: fixed; z-index: 1; display: flex; flex-direction: column; overflow: hidden; transition: left 0.32s cubic-bezier(0.22, 1, 0.36, 1); }
        .main-vis { flex: 1 1 auto; min-height: 0; position: relative; }
        .canvas-wrap { position: absolute; inset: 0; z-index: 1; overflow: hidden; }
        .legend-floating { position: absolute; top: 14px; right: 14px; bottom: auto; width: min(300px, calc(100% - 28px)); max-height: min(38vh, calc(100% - 28px)); z-index: 22; background: rgba(18,18,19,0.96); border: 1px solid rgba(255,255,255,0.12); backdrop-filter: blur(12px); border-radius: 8px; padding: 12px 14px; display: flex; flex-direction: column; box-shadow: 0 8px 32px rgba(0,0,0,0.3); animation: legendPaneIn 0.28s cubic-bezier(0.22, 1, 0.36, 1) both; }
        .legend-tab { position: absolute; top: 14px; right: 14px; bottom: auto; z-index: 22; background: rgba(18,18,19,0.96); border: 1px solid rgba(255,255,255,0.14); color: #c4cad4; font-family: 'JetBrains Mono', monospace; font-size: 11px; padding: 8px 12px; border-radius: 6px; cursor: pointer; letter-spacing: 1px; text-transform: uppercase; animation: legendPaneIn 0.28s cubic-bezier(0.22, 1, 0.36, 1) both; }
        .hints { position: absolute; top: 14px; left: 14px; right: auto; bottom: auto; z-index: 24; text-align: left; user-select: none; max-width: min(280px, 42vw); pointer-events: none; text-shadow: 0 1px 3px rgba(0,0,0,0.85); }
        .favorites-list { margin-top: 10px; border: 1px solid rgba(255,255,255,0.1); border-radius: 4px; max-height: 42vh; overflow-y: auto; background: rgba(0,0,0,0.1); }
        .fav-row { display: flex; align-items: flex-start; gap: 8px; padding: 8px 10px; border-bottom: 1px solid rgba(255,255,255,0.06); cursor: pointer; font-size: 12px; color: #b8c0cc; }
        .fav-row:hover { background: rgba(212,212,216,0.065); color: #f0f2f5; }
        .fav-row-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; line-height: 1.4; }
        .fav-row-remove { opacity: 0; flex-shrink: 0; width: 28px; height: 28px; border: none; background: rgba(255,80,80,0.12); color: #ff6b6b; border-radius: 4px; cursor: pointer; font-size: 18px; line-height: 1; transition: opacity 0.12s; }
        .fav-row:hover .fav-row-remove { opacity: 1; }
        .table-dock-wrap { flex-shrink: 0; display: flex; flex-direction: column; min-height: 0; }
        .table-dock { display: flex; flex-direction: column; border-top: 1px solid rgba(255,255,255,0.12); background: rgba(14,14,15,0.99); backdrop-filter: blur(16px); box-shadow: 0 -8px 32px rgba(0,0,0,0.32); z-index: 12; }
        .table-dock .table-panel { width: 100%; max-height: none; }
        .table-time-filter { padding: 10px 16px 6px; border-bottom: 1px solid rgba(255,255,255,0.08); flex-shrink: 0; }
        .table-time-filter-label { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; font-size: 10px; letter-spacing: 2px; text-transform: uppercase; color: #9aa3b0; }
        .table-time-clear { padding: 2px 8px !important; font-size: 10px !important; }
        .table-time-filter-map-surface { width: 100%; display: flex; flex-direction: column; position: relative; }
        .table-time-filter-axis { position: relative; width: 100%; padding-top: 20px; }
        .table-time-zoom-legend { position: absolute; top: 0; left: 0; z-index: 6; display: flex; flex-direction: column; gap: 1px; font-size: 9px; line-height: 1.25; color: #c4cad4; pointer-events: none; text-shadow: 0 1px 3px rgba(0,0,0,0.85); }
        .table-time-zoom-legend-sub { font-size: 8px; color: #8d95a3; letter-spacing: 0.3px; }
        .table-time-filter-vrules { position: absolute; left: 0; right: 0; top: 20px; bottom: 0; pointer-events: none; z-index: 1; }
        .table-time-filter-vrule { position: absolute; top: 0; bottom: 0; width: 0; margin-left: -0.5px; background: none; pointer-events: none; }
        .table-time-filter-vrule--day { border-left: 2px solid rgba(200, 214, 228, 0.88); margin-left: -1px; }
        .table-time-filter-vrule--hour { border-left: 1px dotted rgba(140, 175, 220, 0.78); }
        .table-time-filter-vrule--sub { border-left: 1px dashed rgba(255, 255, 255, 0.28); }
        .table-time-filter-tickstrip { position: relative; height: 15px; margin-bottom: 4px; font-size: 9px; color: #8d95a3; pointer-events: none; z-index: 2; }
        .table-time-filter-tick { position: absolute; top: 0; transform: translateX(-50%); max-width: 76px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .table-time-filter-track { position: relative; height: 28px; background: rgba(0,0,0,0.25); border-radius: 4px; border: 1px solid rgba(255,255,255,0.1); touch-action: none; z-index: 2; }
        .table-time-filter-heatmap-wrap { position: absolute; inset: 0; pointer-events: none; z-index: 0; border-radius: 3px; overflow: hidden; }
        .table-time-filter-heatcell { position: absolute; top: 0; bottom: 0; box-sizing: border-box; border-right: 1px solid rgba(0,0,0,0.18); }
        .table-time-filter-occ-layer { position: absolute; inset: 0; pointer-events: none; z-index: 3; }
        .table-time-filter-occ { position: absolute; top: 0; bottom: 0; width: 0; margin-left: -0.5px; border-left: 1px solid rgba(120, 195, 255, 0.55); }
        .table-time-filter-occ--selected { border-left: 2px solid rgba(255, 217, 61, 0.92); margin-left: -1px; z-index: 1; }
        .table-time-filter-brush { position: absolute; top: 0; bottom: 0; background: rgba(212,212,216,0.14); border-left: 1px solid rgba(212,212,216,0.32); border-right: 1px solid rgba(212,212,216,0.32); pointer-events: none; box-sizing: border-box; z-index: 2; }
        .table-time-filter-brush--preview { background: rgba(212,212,216,0.1); border-left: 1px dashed rgba(212,212,216,0.45); border-right: 1px dashed rgba(212,212,216,0.45); }
        .table-time-cursor-hint { pointer-events: none; font-size: 10px; line-height: 1.3; color: #e4e7ed; background: rgba(12,12,13,0.94); border: 1px solid rgba(255,255,255,0.14); padding: 4px 8px; border-radius: 4px; white-space: nowrap; box-shadow: 0 4px 14px rgba(0,0,0,0.35); }
        .table-time-filter-ticks { display: flex; justify-content: space-between; align-items: flex-start; margin-top: 6px; font-size: 10px; color: #8d95a3; gap: 8px; }
        .table-time-edge { flex: 0 1 42%; min-width: 0; line-height: 1.35; }
        .table-time-edge:first-child { text-align: left; }
        .table-time-edge:last-child { text-align: right; }
        .table-time-filter-hint { opacity: 0.85; font-size: 9px; letter-spacing: 0.5px; text-align: center; flex: 1; min-width: 0; }
        .table-body th.table-sortable { cursor: pointer; user-select: none; }
        .table-body th.table-sortable:hover { color: #d4d4d8; }
        .table-body th.table-sort-active { color: #e4e7ed; }

        .stat { font-size: 11px; color: #8d95a3; letter-spacing: 1px; text-transform: uppercase; white-space: nowrap; }
        .stat b { color: #d4d4d8; font-weight: 500; }
        .ctrl-btn { background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1); color: #c4cad4; font-family: 'JetBrains Mono', monospace; font-size: 12px; padding: 6px 10px; border-radius: 4px; cursor: pointer; transition: all 0.15s; white-space: nowrap; }
        .ctrl-btn:hover { background: rgba(212,212,216,0.065); border-color: rgba(212,212,216,0.30); color: #d4d4d8; }
        .ctrl-btn.active { background: rgba(212,212,216,0.11); border-color: rgba(212,212,216,0.38); color: #d4d4d8; }
        .app-sidebar { position: fixed; top: ${TOP_BAR_PX}px; left: 0; width: ${SIDEBAR_WIDTH_PX}px; bottom: 0; z-index: 25; display: flex; flex-direction: column; background: rgba(18,18,19,0.97); backdrop-filter: blur(18px); border-right: 1px solid rgba(255,255,255,0.1); transition: transform 0.32s cubic-bezier(0.22, 1, 0.36, 1); will-change: transform; }
        .app-sidebar.is-collapsed { transform: translateX(-100%); pointer-events: none; }
        .sidebar-section { flex: 1 1 50%; min-height: 0; overflow-y: auto; padding: 12px 14px; }
        .sidebar-lists { border-bottom: 1px solid rgba(255,255,255,0.1); }
        .sidebar-section h3 { font-size: 10px; letter-spacing: 2px; color: #9aa3b0; text-transform: uppercase; margin: 12px 0 6px; }
        .sidebar-section h3:first-child { margin-top: 0; }
        .sidebar-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-bottom: 8px; }
        .sidebar-row select, .sidebar-row .filter-q { background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.12); color: #e0e4ea; font-family: 'JetBrains Mono', monospace; font-size: 12px; padding: 5px 8px; border-radius: 4px; outline: none; }
        .sidebar-row select { flex: 1; min-width: 120px; }
        .filter-q { width: 100%; margin-top: 4px; }
        .filter-q:focus { border-color: rgba(212,212,216,0.34); }
        .filter-hint { font-size: 10px; color: #8d95a3; margin-top: 4px; }
        .filter-pick-list { max-height: 100px; overflow-y: auto; border: 1px solid rgba(255,255,255,0.1); border-radius: 4px; margin-top: 4px; background: rgba(0,0,0,0.12); }
        .filter-pick-row { padding: 5px 8px; font-size: 11px; cursor: pointer; color: #b0b8c4; border-bottom: 1px solid rgba(255,255,255,0.06); line-height: 1.3; }
        .filter-pick-row:hover { background: rgba(212,212,216,0.065); color: #f0f2f5; }
        .filter-pick-row.active { color: #d4d4d8; }
        .sidebar-details { display: flex; flex-direction: column; }
        .sidebar-details-inner { position: relative; padding-top: 4px; }
        .sidebar-details-inner .close-btn { position: static; float: right; width: 32px; height: 32px; margin: 0 0 8px 8px; }
        .detail-panel { font-family: inherit; }
        .detail-panel h2 { font-family: 'DM Sans', sans-serif; font-size: 17px; font-weight: 600; color: #f2f4f7; line-height: 1.45; margin-bottom: 14px; clear: both; }
        .detail-meta { font-size: 13px; color: #b4bcc8; margin-bottom: 6px; line-height: 1.5; }
        .detail-meta b { color: #d8dee6; font-weight: 500; }
        .detail-tags { display: flex; flex-wrap: wrap; gap: 6px; margin: 14px 0; }
        .detail-tag { font-size: 11px; padding: 4px 8px; border-radius: 3px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1); color: #a8b0bc; letter-spacing: 0.5px; text-transform: uppercase; }
        .detail-tag.topic { border-color: var(--topic-color, #d4d4d8); color: var(--topic-color, #d4d4d8); background: rgba(212,212,216,0.085); }
        .detail-abstract { font-family: 'DM Sans', sans-serif; font-size: 14px; line-height: 1.75; color: #c4cad4; margin-top: 14px; white-space: pre-wrap; border-top: 1px solid rgba(255,255,255,0.1); padding-top: 14px; }
        .fav-btn { display: inline-flex; align-items: center; gap: 6px; background: rgba(255,217,61,0.05); border: 1px solid rgba(255,217,61,0.15); color: #ffd93d; font-family: 'JetBrains Mono', monospace; font-size: 12px; padding: 7px 14px; border-radius: 4px; cursor: pointer; transition: all 0.15s; margin-top: 12px; }
        .fav-btn:hover { background: rgba(255,217,61,0.1); }
        .fav-btn.is-fav { background: rgba(255,217,61,0.12); border-color: rgba(255,217,61,0.3); }
        .close-btn { background: none; border: 1px solid rgba(255,255,255,0.1); color: #9aa3b0; display: flex; align-items: center; justify-content: center; border-radius: 4px; cursor: pointer; font-size: 18px; transition: all 0.15s; }
        .close-btn:hover { border-color: #ff6b6b; color: #ff6b6b; }
        .detail-empty { color: #9aa3b0; font-size: 12px; line-height: 1.65; padding: 16px 0; }

        .legend-floating .legend-scroll { overflow-y: auto; flex: 1; min-height: 0; margin-top: 6px; }
        .legend-floating h5 { font-size: 10px; color: #9aa3b0; letter-spacing: 2px; text-transform: uppercase; }
        .legend-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-shrink: 0; }
        .legend-collapse { background: none; border: none; color: #a8b0bc; cursor: pointer; font-size: 18px; line-height: 1; padding: 2px 6px; border-radius: 4px; }
        .legend-collapse:hover { color: #d4d4d8; }

        .legend-tab:hover { color: #d4d4d8; border-color: rgba(212,212,216,0.30); }
        .legend-item { display: flex; align-items: center; gap: 8px; font-size: 12px; color: #b4bcc8; margin-bottom: 4px; cursor: pointer; transition: color 0.15s; }
        .legend-item:hover { color: #f0f2f5; }
        .legend-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
        .legend-count { color: #7d8594; margin-left: auto; font-size: 10px; }
        .table-panel { background: transparent; display: flex; flex-direction: column; min-height: 0; }
        .table-panel-main { display: flex; flex-direction: column; flex: 1; min-height: 0; }
        @keyframes paneDropIn { from { opacity: 0; transform: translateY(-8px) scale(0.98); } to { opacity: 1; transform: translateY(0) scale(1); } }
        @keyframes legendPaneIn { from { opacity: 0; transform: translateY(-10px); } to { opacity: 1; transform: translateY(0); } }
        .table-resize-handle { height: 6px; cursor: ns-resize; background: transparent; flex-shrink: 0; display: flex; align-items: center; justify-content: center; }
        .table-resize-handle::after { content: ''; width: 40px; height: 3px; border-radius: 2px; background: rgba(255,255,255,0.18); }
        .table-resize-handle:hover::after { background: rgba(212,212,216,0.34); }
        .table-header { display: flex; align-items: center; justify-content: space-between; padding: 10px 16px; border-bottom: 1px solid rgba(255,255,255,0.1); flex-shrink: 0; }
        .table-header span { font-size: 12px; color: #9aa3b0; letter-spacing: 2px; text-transform: uppercase; }
        .table-body { overflow-y: auto; flex: 1; }
        .table-body table { width: 100%; border-collapse: collapse; font-size: 12px; }
        .table-body th { position: sticky; top: 0; background: #101010; color: #a8b0bc; font-weight: 500; text-align: left; padding: 9px 12px; border-bottom: 1px solid rgba(255,255,255,0.1); font-size: 11px; letter-spacing: 1px; text-transform: uppercase; white-space: nowrap; }
        .table-body td { padding: 9px 12px; border-bottom: 1px solid rgba(255,255,255,0.06); color: #c4cad4; max-width: 400px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .table-body tr { cursor: pointer; transition: background 0.1s; }
        .table-body tr:hover { background: rgba(212,212,216,0.055); }
        .table-body tr:hover td { color: #f0f2f5; }
        .table-body tr.table-agenda-date td { background: rgba(212,212,216,0.065); color: #d4d4d8; font-size: 11px; letter-spacing: 2px; text-transform: uppercase; font-weight: 600; border-bottom: 1px solid rgba(212,212,216,0.13); cursor: default; }
        .table-body tr.table-agenda-date:hover { background: transparent; }
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
          onChange={(e) => setSearchTerm(e.target.value)}
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
        <div className="type-filter-wrap">
          <button
            type="button"
            className={`ctrl-btn${typeFilter === null ? " active" : ""}`}
            onClick={() => setTypeFilter(null)}
          >All</button>
          <button
            type="button"
            className={`ctrl-btn${typeFilter === "poster" ? " active" : ""}`}
            onClick={() => setTypeFilter("poster")}
          >Posters</button>
          <button
            type="button"
            className={`ctrl-btn${typeFilter === "talk" ? " active" : ""}`}
            onClick={() => setTypeFilter("talk")}
          >Talks</button>
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
                <div style={{ fontSize: 10, color: "#8d95a3", letterSpacing: 2, marginBottom: 10 }}>#{selected.id} · {selected.type === "talk" ? "TALK" : `POSTER ${selected.posterNumber}`} · {formatAbstractTimeLabel(selected.start)}</div>
                <h2>{selected.title}</h2>
                <AffiliationView institution={selected.institution} authors={selected.authors} presenter={selected.presenter} />
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
              <color attach="background" args={["#080808"]} />
              <PointCloud
                abstracts={abstracts}
                embeddings={embeddings}
                filteredSet={filteredSet}
                pickIndices={mapPickIndices}
                searchSimilarity={searchSimilarity}
                clusterColors={clusterColors}
                topicColors={topicColors}
                topicFilterSelected={topicFilterSelected}
                selectedId={selectedId}
                onSelect={setSelectedId}
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
                autoRotate={autoRotate}
                autoRotateSpeed={0.5}
                onStart={() => {
                  scatterOrbitActiveRef.current = true;
                }}
                onEnd={() => {
                  scatterOrbitActiveRef.current = false;
                  if (scatterOrbitDragExceededRef.current) {
                    scatterSuppressNextClickRef.current = true;
                    scatterOrbitDragExceededRef.current = false;
                  }
                  scatterOrbitPointerDownRef.current = null;
                }}
              />
              <SmoothZoom minDist={ZOOM_MIN} maxDist={ZOOM_MAX} />
              <GizmoHelper alignment="bottom-right" margin={[72, 168]}>
                <GizmoViewport axisColors={["#b09090", "#b0b0b4", "#9098a0"]} labelColor="#d0d0d4" />
              </GizmoHelper>
            </Canvas>

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

          <div className="hints">
            <p>DRAG <b>ROTATE</b> · SCROLL <b>ZOOM</b> · RIGHT-DRAG <b>PAN</b></p>
            <p>SHIFT + DRAG <b>LOCK HORIZONTAL</b></p>
          </div>
        </div>

        <div className="table-dock-wrap">
          <div className="table-dock">
            <div className="table-panel" style={{ height: tableHeight }} onClick={(e) => e.stopPropagation()}>
              <div className="table-resize-handle" onMouseDown={handleTableResizeStart} />
              {timeDomain ? (
                <TableTimeFilterBar
                  domain={timeDomain}
                  viewMin={tlView.min}
                  viewMax={tlView.max}
                  filterMin={tlFilter.min}
                  filterMax={tlFilter.max}
                  onViewChange={setTlView}
                  onFilterChange={handleTimelineFilterChange}
                  onClearFilter={() => {
                    if (!timeDomain) return;
                    setTlFilter({ min: timeDomain.min, max: timeDomain.max });
                    setTlView({ min: timeDomain.min, max: timeDomain.max });
                  }}
                  heatmapStats={heatmapStats}
                  occurrenceMarkerTimes={occurrenceMarkerTimes}
                  selectedTimeMs={selectedTimeMsForTimeline}
                />
              ) : null}
              <div className="table-panel-main">
              <div className="table-header">
                <span>Abstracts ({sortedTableAbstracts.length})</span>
              </div>
              <div className="table-body" ref={tableBodyRef} onScroll={onTableBodyScroll}>
                <table>
                  <thead>
                    <tr>
                      <th className={`table-sortable${sortCol === "type" ? " table-sort-active" : ""}`} onClick={() => toggleTableSort("type")}>Type{sortCol === "type" ? (sortDir === "asc" ? " \u2191" : " \u2193") : ""}</th>
                      <th className={`table-sortable${sortCol === "time" ? " table-sort-active" : ""}`} onClick={() => toggleTableSort("time")}>Time{sortCol === "time" ? (sortDir === "asc" ? " \u2191" : " \u2193") : ""}</th>
                      <th className={`table-sortable${sortCol === "poster" ? " table-sort-active" : ""}`} onClick={() => toggleTableSort("poster")}>Poster{sortCol === "poster" ? (sortDir === "asc" ? " \u2191" : " \u2193") : ""}</th>
                      <th className={`table-sortable${sortCol === "title" ? " table-sort-active" : ""}`} onClick={() => toggleTableSort("title")}>Title{sortCol === "title" ? (sortDir === "asc" ? " \u2191" : " \u2193") : ""}</th>
                      <th className={`table-sortable${sortCol === "session" ? " table-sort-active" : ""}`} onClick={() => toggleTableSort("session")}>Session{sortCol === "session" ? (sortDir === "asc" ? " \u2191" : " \u2193") : ""}</th>
                      <th className={`table-sortable${sortCol === "topic" ? " table-sort-active" : ""}`} onClick={() => toggleTableSort("topic")}>Topic{sortCol === "topic" ? (sortDir === "asc" ? " \u2191" : " \u2193") : ""}</th>
                      <th className={`table-sortable${sortCol === "fav" ? " table-sort-active" : ""}`} onClick={() => toggleTableSort("fav")}>Fav{sortCol === "fav" ? (sortDir === "asc" ? " \u2191" : " \u2193") : ""}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleTableAbstracts.flatMap((a, idx) => {
                      const prev = idx === 0 ? null : visibleTableAbstracts[idx - 1];
                      const showDate =
                        !prev || formatAgendaDate(parseStartMs(a.start)) !== formatAgendaDate(parseStartMs(prev.start));
                      const rows = [];
                      if (showDate) {
                        rows.push(
                          <tr key={`agenda-hdr-${a.internalId}-${idx}`} className="table-agenda-date">
                            <td colSpan={7}>{formatAgendaDate(parseStartMs(a.start))}</td>
                          </tr>
                        );
                      }
                      rows.push(
                        <tr key={a.id + String(a.internalId)} onClick={() => { const i = abstracts.findIndex((x) => x.id === a.id); setSelectedId(i >= 0 ? i : null); }}>
                          <td style={{ whiteSpace: "nowrap", color: a.type === "talk" ? "#b8bcc2" : "#a8b0bc", textTransform: "uppercase", fontSize: 10, letterSpacing: 1 }}>{a.type || "poster"}</td>
                          <td style={{ whiteSpace: "nowrap", color: "#b0b8c4" }}>{formatAbstractTimeLabel(a.start)}</td>
                          <td style={{ whiteSpace: "nowrap", color: "#a8b0bc" }}>{a.posterNumber || "—"}</td>
                          <td style={{ color: "#e4e7ed", maxWidth: 280 }}>{a.title}</td>
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
      </div>
    </div>
  );
}
