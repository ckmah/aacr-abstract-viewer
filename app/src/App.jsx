import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { Canvas, useThree, useFrame, extend } from "@react-three/fiber";
import { OrbitControls, GizmoHelper, GizmoViewport, shaderMaterial, Billboard } from "@react-three/drei";
import { EffectComposer, Bloom, Vignette, N8AO } from "@react-three/postprocessing";
import * as THREE from "three";

const PICK_RADIUS_PX = 30;
const ZOOM_STOP_COUNT = 22;

/* ── Topic / cluster palette: mid-chroma, separated hues, readable on #080808 ── */
const PALETTE = [
  "#5eb0ff", "#4fd4e0", "#4ee0b8", "#7ede7a", "#b8e65c",
  "#e8e050", "#ffcc4d", "#ff9f5c", "#ff7a6e", "#ff6eb0",
  "#e070ff", "#b08cff", "#8f9dff", "#6aa8ff", "#4ec8f2",
  "#3dd4c0", "#5ee399", "#c4e860", "#ffb84d", "#ff8c7a",
  "#ff7ec8", "#d494ff", "#9d9dff", "#7ab0ff", "#5cd4f0",
  "#45e0c8", "#8ee878", "#f0e868", "#ffac68", "#ff9090",
  "#ff90d0", "#c898ff", "#98a8ff", "#78c0ff", "#50d8e0",
  "#68e8a0", "#d8e878", "#ffc078",
];
const DIM_POINT_HEX = "#4f5868";
const TOPIC_FALLBACK_HEX = "#9eb0c8";

const FAVORITE_IDS_KEY = "aacr-favorite-ids";
const LISTS_STORAGE_KEY = "aacr-favorite-lists";
const LISTS_LEGACY_KEY = "aacr-favorites";
const FAVORITE_POINT_COLOR = "#ffd93d";
const ZOOM_MIN = 0.32;
const ZOOM_MAX = 1.65;
/** Orbit camera distance from target; tighter = more zoomed in. */
function cameraOrbitDistanceForRadius(r) {
  const rr = Math.max(r, 0.012);
  const d = rr * 2.85 + 0.09;
  return THREE.MathUtils.clamp(d, ZOOM_MIN, ZOOM_MAX);
}

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

/** Friday 12:00 local on or before ms (conference week padding). */
function fridayNoonOnOrBefore(ms) {
  const d = new Date(ms);
  d.setMilliseconds(0);
  d.setSeconds(0);
  d.setMinutes(0);
  d.setHours(0);
  const daysBack = (d.getDay() - 5 + 7) % 7;
  d.setDate(d.getDate() - daysBack);
  d.setHours(12, 0, 0, 0);
  if (d.getTime() > ms) d.setDate(d.getDate() - 7);
  return d.getTime();
}

/** Wednesday 15:00 local on or after ms (conference week padding). */
function wednesday3pmOnOrAfter(ms) {
  const d = new Date(ms);
  d.setMilliseconds(0);
  d.setSeconds(0);
  d.setMinutes(0);
  d.setHours(0);
  const daysFwd = (3 - d.getDay() + 7) % 7;
  d.setDate(d.getDate() + daysFwd);
  d.setHours(15, 0, 0, 0);
  if (d.getTime() < ms) d.setDate(d.getDate() + 7);
  return d.getTime();
}

function programTimeDomainFromRows(rows) {
  const raw = timeDomainFromRows(rows);
  if (!raw) return null;
  return {
    min: fridayNoonOnOrBefore(raw.min),
    max: wednesday3pmOnOrAfter(raw.max),
  };
}

function startOfLocalDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function endOfLocalDay(ms) {
  const d = new Date(startOfLocalDay(ms));
  d.setDate(d.getDate() + 1);
  return d.getTime() - 1;
}

function agendaDaysFromAbstracts(rows) {
  const seen = new Set();
  const out = [];
  for (const a of rows) {
    const t = rowTimeMs(a);
    if (!t) continue;
    const start = startOfLocalDay(t);
    if (seen.has(start)) continue;
    seen.add(start);
    out.push({
      key: String(start),
      startMs: start,
      endMs: endOfLocalDay(t),
      label: new Date(start).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }),
    });
  }
  out.sort((x, y) => x.startMs - y.startMs);
  return out;
}

const MS = 1;
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** Default block length when `end` is missing (dataset has start only). */
const ICS_DEFAULT_TALK_MS = 30 * MIN;
const ICS_DEFAULT_POSTER_MS = 60 * MIN;

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

/** Compact axis labels: "Sat 8AM" on the hour, "8:30AM" on the half hour. */
function formatTimelineTickShort(ms) {
  const d = new Date(ms);
  const h24 = d.getHours();
  const min = d.getMinutes();
  const h12 = h24 % 12 || 12;
  const ampm = h24 >= 12 ? "PM" : "AM";
  if (min === 30) return `${h12}:30${ampm}`;
  if (min === 0) {
    const wd = d.toLocaleDateString("en-US", { weekday: "short" });
    return `${wd} ${h12}${ampm}`;
  }
  return `${h12}:${String(min).padStart(2, "0")}${ampm}`;
}

function formatTimelineInstant(ms, spanMs) {
  const d = new Date(ms);
  if (spanMs <= 7 * DAY) return formatTimelineTickShort(ms);
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
  if (spanMs <= 7 * DAY) return formatTimelineTickShort(ms);
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
  let step = pickNiceTickStep(span, maxTicks + 1);
  if (span <= 36 * HOUR && step >= HOUR) step = 30 * MIN;
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

function collectMidnightMsInRange(v0, v1) {
  const out = [];
  const cur = new Date(v0);
  cur.setMilliseconds(0);
  cur.setSeconds(0);
  cur.setMinutes(0);
  cur.setHours(0);
  if (cur.getTime() < v0) cur.setDate(cur.getDate() + 1);
  while (cur.getTime() <= v1) {
    out.push(cur.getTime());
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

function buildTimelineTicksAtMidnight(v0, v1, domainMin, domainMax, maxTicks = 6) {
  const span = v1 - v0;
  if (!Number.isFinite(span) || span <= 0) return [];
  let raw = collectMidnightMsInRange(v0, v1);
  if (raw.length > maxTicks) raw = thinSortedTimes(raw, maxTicks);
  const ticks = [];
  for (const ms of raw) {
    const clamped = Math.min(Math.max(ms, domainMin), domainMax);
    const frac = (clamped - v0) / span;
    if (frac < 0.04 || frac > 0.96) continue;
    ticks.push({ ms: clamped, frac, key: `tl0-${Math.round(clamped)}` });
    if (ticks.length >= maxTicks) break;
  }
  return ticks;
}

function buildMainTimelineTicks(v0, v1, domainMin, domainMax, maxTicks = 6) {
  let t = buildTimelineTicksAtMidnight(v0, v1, domainMin, domainMax, maxTicks);
  if (t.length === 0) t = buildTimelineTicks(v0, v1, domainMin, domainMax, maxTicks);
  return t;
}

function classifyTimelineMarkKind(ms) {
  const s = Math.round(ms / 1000) * 1000;
  const d = new Date(s);
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

function TableTimeFilterBar({
  domain,
  filterMin,
  filterMax,
  onFilterChange,
  onClearFilter,
  heatmapStats,
  occurrenceMarkerTimes,
  selectedTimeMs,
  nowMs,
}) {
  const trackRef = useRef(null);
  const timelineMapRef = useRef(null);
  const drag = useRef(null);
  const [hoverHint, setHoverHint] = useState(null);
  const [rangePreview, setRangePreview] = useState(null);

  const v0 = domain.min;
  const v1 = domain.max;
  const viewSpan = Math.max(v1 - v0, MIN);

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
      const c = d.mode === "move" ? "grabbing" : "crosshair";
      trackRef.current.style.cursor = c;
    }
    if (!d || !trackRef.current) return;
    const rect = trackRef.current.getBoundingClientRect();
    const w = rect.width;
    const totalDx = e.clientX - d.pointerDownX;
    const dMs = (totalDx / w) * (d.initialV1 - d.initialV0);

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
    if (inBrush) {
      el.style.cursor = "grabbing";
      drag.current = {
        mode: "move",
        pointerDownX: e.clientX,
        initialV0: v0,
        initialV1: v1,
        initialF0: filterMin,
        initialF1: filterMax,
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

  if (!domain) return null;

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
        <span>Program time</span>
        <button
          type="button"
          className={`ctrl-btn table-time-clear${atFullDomain ? " table-time-clear--concealed" : ""}`}
          onClick={onClearFilter}
          aria-hidden={atFullDomain}
          tabIndex={atFullDomain ? -1 : 0}
        >
          Show all times
        </button>
      </div>
      <div className="table-time-filter-axis">
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
          aria-label="Filter by program time. Drag to select a time range, or drag the shaded band to move it."
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
                    title={`${bin.count} abstract${bin.count === 1 ? "" : "s"} this hour`}
                  />
                );
              })}
            </div>
          ) : null}
          <div className="table-time-filter-occ-layer" aria-hidden>
            {nowMs != null && (() => {
              const frac = (nowMs - v0) / viewSpan;
              if (frac < -0.002 || frac > 1.002) return null;
              return (
                <div
                  className="table-time-filter-now"
                  style={{ left: `${Math.min(1, Math.max(0, frac)) * 100}%` }}
                />
              );
            })()}
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
        <span className="table-time-filter-hint">Drag to select a time range · drag the band to move it</span>
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

function stripHtmlToPlain(html) {
  if (!html) return "";
  return String(html)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\r\n|\r/g, "\n")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => {
      const c = parseInt(n, 10);
      return c >= 32 && c < 0x110000 ? String.fromCodePoint(c) : "";
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      const c = parseInt(h, 16);
      return c >= 32 && c < 0x110000 ? String.fromCodePoint(c) : "";
    })
    .trim();
}

function escapeIcsText(s) {
  return String(s)
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
}

function formatIcsUtc(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function abstractIcsSummary(a) {
  const t = (a.title || "").trim() || `Abstract ${a.id}`;
  if (a.type === "poster" && a.posterNumber) return `${t} (Poster ${a.posterNumber})`;
  return t;
}

function buildAbstractIcsDescription(a) {
  const blocks = [];
  if (a.session) blocks.push(`Session: ${stripHtmlToPlain(a.session)}`);
  if (a.clusterTopic) blocks.push(`Topic: ${a.clusterTopic}`);
  const inst = stripHtmlToPlain(a.institution || "");
  if (inst) blocks.push(`Institution: ${inst}`);
  const people = unifiedPeopleText(a.authors, a.presenter);
  if (people && people !== "—") blocks.push(people);
  const body = stripHtmlToPlain(a.abstract || "");
  if (body) blocks.push(body.length > 6000 ? `${body.slice(0, 6000)}…` : body);
  return blocks.join("\n\n");
}

function icsUid(a) {
  const id = String(a.id ?? "").replace(/[^\w.-]/g, "_");
  const iid = a.internalId != null ? String(a.internalId) : "x";
  return `aacr-${iid}-${id}@aacr-abstract-viewer`;
}

function veventLinesForAbstract(a) {
  const startMs = parseStartMs(a.start);
  if (!startMs) return [];
  let endMs = parseStartMs(a.end);
  if (!endMs || endMs <= startMs) {
    endMs = startMs + (a.type === "poster" ? ICS_DEFAULT_POSTER_MS : ICS_DEFAULT_TALK_MS);
  }
  const lines = [
    "BEGIN:VEVENT",
    `UID:${icsUid(a)}`,
    `DTSTAMP:${formatIcsUtc(Date.now())}`,
    `DTSTART:${formatIcsUtc(startMs)}`,
    `DTEND:${formatIcsUtc(endMs)}`,
    `SUMMARY:${escapeIcsText(abstractIcsSummary(a))}`,
  ];
  if (a.session) {
    const loc = stripHtmlToPlain(a.session);
    if (loc) lines.push(`LOCATION:${escapeIcsText(loc)}`);
  }
  const desc = buildAbstractIcsDescription(a);
  if (desc) lines.push(`DESCRIPTION:${escapeIcsText(desc)}`);
  lines.push("END:VEVENT");
  return lines;
}

function buildIcsCalendar(abstractRows) {
  const sorted = [...abstractRows].sort(
    (x, y) => (parseStartMs(x.start) || 0) - (parseStartMs(y.start) || 0),
  );
  const body = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//AACR Abstract Viewer//EN",
    "CALSCALE:GREGORIAN",
    "X-WR-CALNAME:AACR 2026",
    ...sorted.flatMap((a) => veventLinesForAbstract(a)),
    "END:VCALENDAR",
  ].join("\r\n");
  return body;
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
        {institution ? <div className="detail-meta"><b>Institution</b> {institution}</div> : null}
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
  return `rgb(${Math.round(52 + 100 * t)},${Math.round(58 + 95 * t)},${Math.round(88 + 130 * t)})`;
}

function displayTopicCssColor(hex) {
  if (!hex) return "var(--text)";
  return `color-mix(in oklch, ${hex} 68%, var(--text))`;
}

const POINT_SPRITE_VERT = `
  attribute float aSel;
  varying vec3 vColor;
  varying float vDistance;
  varying float vSel;
  uniform float uRadius;

  void main() {
    vColor = color;
    vSel = aSel > 0.5 ? 1.0 : 0.0;

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
  clusterColors, topicColors, topicFilterSelected, selectedIndices, onSelect,
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
      let hex = !filteredSet.has(i) ? DIM_POINT_HEX
        : searchSimilarity ? similarityColor(searchSimilarity[i])
        : topicFilterOn
          ? (topicColors[topic] || TOPIC_FALLBACK_HEX)
          : (clusterColors[abstracts[i].cluster] || TOPIC_FALLBACK_HEX);
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

  const selFlags = useMemo(() => {
    const a = new Float32Array(N);
    for (const i of selectedIndices) {
      if (i >= 0 && i < N) a[i] = 1;
    }
    return a;
  }, [selectedIndices, N]);

  useEffect(() => {
    if (!geomRef.current || N === 0) return;
    geomRef.current.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const colAttr = new THREE.BufferAttribute(baseColors.slice(), 3);
    colAttr.setUsage(THREE.DynamicDrawUsage);
    geomRef.current.setAttribute("color", colAttr);
    const selAttr = new THREE.BufferAttribute(new Float32Array(N), 1);
    selAttr.setUsage(THREE.DynamicDrawUsage);
    geomRef.current.setAttribute("aSel", selAttr);
    geomRef.current.computeBoundingSphere();
  }, [positions, baseColors, N]);

  useEffect(() => {
    if (!geomRef.current || N === 0) return;
    const attr = geomRef.current.getAttribute("aSel");
    if (!attr || !attr.array || attr.array.length !== N) return;
    attr.array.set(selFlags);
    attr.needsUpdate = true;
  }, [selFlags, N]);

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

  const selectionCentroid = useMemo(() => {
    if (!selectedIndices.length) return null;
    const pts = [];
    for (const i of selectedIndices) {
      if (!abstracts[i] || !isSemanticMapPoint(abstracts[i])) continue;
      const e = embeddings[i];
      pts.push([e.x - 0.5, e.y - 0.5, (e.z ?? 0) - 0.5]);
    }
    if (!pts.length) return null;
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (const p of pts) {
      cx += p[0];
      cy += p[1];
      cz += p[2];
    }
    cx /= pts.length;
    cy /= pts.length;
    cz /= pts.length;
    return [cx, cy, cz];
  }, [selectedIndices, embeddings, abstracts]);

  return (
    <>
      <points raycast={() => null}>
        <bufferGeometry ref={geomRef} />
        <pointSpriteMaterial />
      </points>
      {selectionCentroid ? <SelectionRing position={selectionCentroid} /> : null}
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

/* ── Smooth zoom: discrete log-spaced stops + eased lerp (distance from orbit target) ── */
function SmoothZoom({ minDist, maxDist, orbitControlsRef, wheelResetKey = 0 }) {
  const { camera, gl } = useThree();
  const targetRef = useRef(null);
  const stops = useMemo(
    () => zoomStopDistances(minDist, maxDist, ZOOM_STOP_COUNT),
    [minDist, maxDist],
  );

  useEffect(() => {
    targetRef.current = null;
    scatterZoomActiveRef.current = false;
  }, [wheelResetKey]);

  useEffect(() => {
    const el = gl.domElement;
    const onWheel = (e) => {
      e.preventDefault();
      scatterZoomActiveRef.current = true;
      const ctrl = orbitControlsRef?.current;
      const t = ctrl?.target;
      let len = targetRef.current;
      if (len == null) {
        len = t ? camera.position.distanceTo(t) : camera.position.length();
      }
      const i = nearestZoomStopIndex(len, stops);
      const next = e.deltaY > 0 ? Math.min(stops.length - 1, i + 1) : Math.max(0, i - 1);
      targetRef.current = stops[next];
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [gl, camera, stops, orbitControlsRef]);

  useFrame(() => {
    if (targetRef.current === null) {
      scatterZoomActiveRef.current = false;
      return;
    }
    const ctrl = orbitControlsRef?.current;
    const t = ctrl?.target;
    if (t) {
      const off = camera.position.clone().sub(t);
      const cur = off.length();
      const next = cur + (targetRef.current - cur) * 0.075;
      if (Math.abs(next - targetRef.current) < 0.001) {
        off.normalize().multiplyScalar(targetRef.current);
        camera.position.copy(t).add(off);
        targetRef.current = null;
        scatterZoomActiveRef.current = false;
      } else {
        off.normalize().multiplyScalar(next);
        camera.position.copy(t).add(off);
      }
      ctrl.update();
    } else {
      const cur = camera.position.length();
      const next = cur + (targetRef.current - cur) * 0.075;
      if (Math.abs(next - targetRef.current) < 0.001) {
        camera.position.setLength(targetRef.current);
        targetRef.current = null;
        scatterZoomActiveRef.current = false;
      } else {
        camera.position.setLength(next);
      }
    }
  });

  return null;
}

/** World-space direction from orbit target to camera for the default / reset pose (matches initial Canvas camera on +Z). */
const SCATTER_HOME_VIEW_DIR = new THREE.Vector3(0, 0, 1);
const tmpHomeCamOff = new THREE.Vector3();

function snapScatterOrbitToHome(orbitControlsRef, camera, homeGeometry) {
  const ctrl = orbitControlsRef?.current;
  if (!ctrl || !camera) return;
  const [cx, cy, cz] = homeGeometry.centroid;
  const dist = cameraOrbitDistanceForRadius(homeGeometry.radius);
  ctrl.target.set(cx, cy, cz);
  tmpHomeCamOff.copy(SCATTER_HOME_VIEW_DIR).multiplyScalar(dist);
  camera.position.copy(ctrl.target).add(tmpHomeCamOff);
  ctrl.update();
}

function selectionFocusFromIndices(indices, embeddings, abstracts) {
  if (!indices.length) return null;
  const pts = [];
  for (const i of indices) {
    if (!abstracts[i] || !isSemanticMapPoint(abstracts[i])) continue;
    const e = embeddings[i];
    pts.push([e.x - 0.5, e.y - 0.5, (e.z ?? 0) - 0.5]);
  }
  if (!pts.length) return null;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (const p of pts) {
    cx += p[0];
    cy += p[1];
    cz += p[2];
  }
  cx /= pts.length;
  cy /= pts.length;
  cz /= pts.length;
  let maxR = 0;
  for (const p of pts) {
    maxR = Math.max(maxR, Math.hypot(p[0] - cx, p[1] - cy, p[2] - cz));
  }
  return { centroid: [cx, cy, cz], radius: maxR };
}

function SelectionCameraRig({ orbitControlsRef, cameraFocusPayload, payloadKey, homeGeometry, homeViewResetNonce }) {
  const { camera } = useThree();
  const goalTarget = useRef(new THREE.Vector3(0, 0, 0));
  const goalDist = useRef(2);
  const tmpV = useRef(new THREE.Vector3());
  const animating = useRef(true);
  const lastHomeResetNonce = useRef(homeViewResetNonce);

  useLayoutEffect(() => {
    if (homeViewResetNonce !== lastHomeResetNonce.current) {
      lastHomeResetNonce.current = homeViewResetNonce;
      if (homeViewResetNonce !== 0) {
        const d = cameraOrbitDistanceForRadius(homeGeometry.radius);
        goalTarget.current.fromArray(homeGeometry.centroid);
        goalDist.current = d;
        snapScatterOrbitToHome(orbitControlsRef, camera, homeGeometry);
        animating.current = false;
        return;
      }
    }
    animating.current = true;
    const p = cameraFocusPayload;
    const [cx, cy, cz] = p.centroid;
    goalTarget.current.set(cx, cy, cz);
    const r = Math.max(p.radius, 0.012);
    const want = cameraOrbitDistanceForRadius(r);
    goalDist.current = p.kind === "home" ? p.maxDist : Math.min(p.maxDist, want);
  }, [payloadKey, cameraFocusPayload, homeViewResetNonce, homeGeometry, orbitControlsRef, camera]);

  useFrame(() => {
    const ctrl = orbitControlsRef.current;
    if (!ctrl || !animating.current) return;
    ctrl.target.lerp(goalTarget.current, 0.085);
    const off = tmpV.current.copy(camera.position).sub(ctrl.target);
    let dist = off.length();
    if (dist < 1e-5) off.set(0.12, 0.2, 1).normalize();
    else off.normalize();
    dist += (goalDist.current - dist) * 0.085;
    camera.position.copy(ctrl.target).add(off.multiplyScalar(dist));
    ctrl.update();
    const dT = ctrl.target.distanceTo(goalTarget.current);
    const dD = Math.abs(camera.position.distanceTo(ctrl.target) - goalDist.current);
    if (dT < 0.018 && dD < 0.035) animating.current = false;
  });

  return null;
}

const VIEWPORT_NARROW_PX = 768;

function useViewportNarrow(breakpointPx) {
  const [narrow, setNarrow] = useState(
    () => (typeof window !== "undefined" ? window.matchMedia(`(max-width: ${breakpointPx}px)`).matches : false),
  );
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpointPx}px)`);
    const onChange = () => setNarrow(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [breakpointPx]);
  return narrow;
}

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
  });
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!mq) return;
    const onChange = () => setReduced(mq.matches);
    onChange();
    if (mq.addEventListener) mq.addEventListener("change", onChange);
    else mq.addListener(onChange);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener("change", onChange);
      else mq.removeListener(onChange);
    };
  }, []);
  return reduced;
}

function ScatterRendererTuning({ narrow }) {
  const { gl } = useThree();
  useEffect(() => {
    gl.toneMapping = THREE.ACESFilmicToneMapping;
    gl.toneMappingExposure = narrow ? 1.0 : 1.07;
  }, [gl, narrow]);
  return null;
}

function ScatterPostFX({ enabled }) {
  if (!enabled) return null;
  return (
    <EffectComposer multisampling={4}>
      <N8AO halfRes quality="performance" intensity={0.45} aoRadius={0.22} distanceFalloff={0.9} />
      <Bloom mipmapBlur intensity={0.24} luminanceThreshold={0.62} luminanceSmoothing={0.12} />
      <Vignette eskil={false} offset={0.24} darkness={0.58} />
    </EffectComposer>
  );
}

function ExportDropMenu({ onExport, className = "" }) {
  const run = (favOnly) => (e) => {
    onExport(favOnly);
    e.currentTarget.closest("details.export-drop")?.removeAttribute("open");
  };
  return (
    <details className={`export-drop ${className}`.trim()} aria-label="Download calendar file">
      <summary
        className="ctrl-btn export-drop-trigger"
        title="Creates a file you can open in Apple Calendar, Google Calendar, Outlook, and similar apps."
      >
        Calendar
      </summary>
      <div className="export-drop-panel" onMouseDown={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="ctrl-btn export-drop-opt"
          onClick={run(false)}
          title="Uses your current search, topic, session, type, and time filters."
        >
          Current list
        </button>
        <button
          type="button"
          className="ctrl-btn export-drop-opt"
          onClick={run(true)}
          title="Only abstracts you starred."
        >
          Favorites only
        </button>
      </div>
    </details>
  );
}

/* ── Main App ── */
export default function AACRExplorer() {
  const [abstracts, setAbstracts] = useState([]);
  const [embeddings, setEmbeddings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingStatus, setLoadingStatus] = useState("Fetching abstracts...");

  const [selectedIndices, setSelectedIndices] = useState([]);
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
  const [tableHeight, setTableHeight] = useState(350);
  const TABLE_INITIAL_VISIBLE = 80;
  const TABLE_SCROLL_CHUNK = 100;
  const [tableVisibleCount, setTableVisibleCount] = useState(TABLE_INITIAL_VISIBLE);
  const tableBodyRef = useRef(null);
  const [autoRotate, setAutoRotate] = useState(false);
  const [tlFilter, setTlFilter] = useState({ min: 0, max: 1 });
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [sortCol, setSortCol] = useState("time");
  const [sortDir, setSortDir] = useState("asc");
  const narrow = useViewportNarrow(VIEWPORT_NARROW_PX);
  const reducedMotion = usePrefersReducedMotion();
  const searchInputRef = useRef(null);
  const didAutoNowRef = useRef(false);

  const orbitControlsRef = useRef(null);
  const timelineRailRef = useRef(null);
  const [timelineRailH, setTimelineRailH] = useState(0);
  const layoutTopPx = narrow ? 88 : TOP_BAR_PX;
  const [scatterHomeViewNonce, setScatterHomeViewNonce] = useState(0);

  const handleReset = useCallback(() => {
    setScatterHomeViewNonce((n) => n + 1);
  }, []);

  const applySelection = useCallback((index) => {
    setSelectedIndices(index == null ? [] : [index]);
  }, []);

  const focusSingleIndex = useCallback((index) => {
    if (index == null) setSelectedIndices([]);
    else setSelectedIndices([index]);
  }, []);

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
    const onKey = (e) => {
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || document.activeElement?.isContentEditable) return;
      e.preventDefault();
      searchInputRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
      if (!e.target.closest?.(".export-drop")) {
        document.querySelectorAll("details.export-drop[open]").forEach((el) => {
          el.removeAttribute("open");
        });
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

  const exportIcs = (favOnly = false) => {
    const items = favOnly ? abstracts.filter((a) => activeListIds.has(a.id)) : filteredIndices.map((i) => abstracts[i]);
    const cal = buildIcsCalendar(items);
    const blob = new Blob([cal], { type: "text/calendar;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = favOnly ? "aacr_favorites.ics" : "aacr_filtered.ics";
    link.click();
    URL.revokeObjectURL(url);
  };

  const selectedSet = useMemo(() => new Set(selectedIndices), [selectedIndices]);
  const primaryDetailIndex =
    selectedIndices.length > 0 ? selectedIndices[selectedIndices.length - 1] : null;
  const selected = primaryDetailIndex !== null ? abstracts[primaryDetailIndex] ?? null : null;
  const tableData = useMemo(() => filteredIndices.map((i) => abstracts[i]), [filteredIndices, abstracts]);
  const timeDomain = useMemo(() => programTimeDomainFromRows(abstracts), [abstracts]);
  const heatmapStats = useMemo(() => buildHourlyHeatmapStats(abstracts, timeDomain), [abstracts, timeDomain]);
  const occurrenceMarkerTimes = useMemo(() => uniqueSortedMarkerTimes(tableData, 1200), [tableData]);
  const selectionFocusKey = useMemo(
    () => [...selectedIndices].sort((a, b) => a - b).join(","),
    [selectedIndices],
  );
  const scatterFocusIndices = useMemo(() => {
    if (!timeDomain) return mapPickIndices;
    const fMin = tlFilter.min;
    const fMax = tlFilter.max;
    const atFull = fMin <= timeDomain.min + 1000 && fMax >= timeDomain.max - 1000;
    return mapPickIndices.filter((i) => {
      const t = rowTimeMs(abstracts[i]);
      if (!t) return atFull;
      return t >= fMin && t <= fMax;
    });
  }, [mapPickIndices, timeDomain, tlFilter, abstracts]);

  const mapHomeGeometry = useMemo(() => {
    const f = selectionFocusFromIndices(mapPickIndices, embeddings, abstracts);
    if (f) return f;
    return { centroid: [0, 0, 0], radius: 0.22 };
  }, [mapPickIndices, embeddings, abstracts]);

  const selectionCameraKey = useMemo(() => {
    const inView = new Set(scatterFocusIndices);
    const selOn = selectedIndices.filter((i) => inView.has(i));
    const valid = selOn.length > 0 ? "1" : "0";
    return `${selectionFocusKey}|${valid}`;
  }, [selectionFocusKey, selectedIndices, scatterFocusIndices]);

  const cameraFocusPayload = useMemo(() => {
    const home = mapHomeGeometry;
    const maxDist = cameraOrbitDistanceForRadius(home.radius);
    const homePayload = {
      kind: "home",
      centroid: home.centroid,
      radius: home.radius,
      maxDist,
    };
    if (selectedIndices.length === 0) return homePayload;
    const inView = new Set(scatterFocusIndices);
    const sel = selectedIndices.filter(
      (i) => inView.has(i) && abstracts[i] && isSemanticMapPoint(abstracts[i]),
    );
    if (!sel.length) return homePayload;
    const f = selectionFocusFromIndices(sel, embeddings, abstracts);
    if (!f) return homePayload;
    return {
      kind: "focus",
      centroid: f.centroid,
      radius: f.radius,
      maxDist,
    };
  }, [mapHomeGeometry, selectedIndices, scatterFocusIndices, embeddings, abstracts]);

  const mapVisualActiveSet = useMemo(() => new Set(scatterFocusIndices), [scatterFocusIndices]);
  const selectedTimeMsForTimeline = useMemo(() => {
    if (primaryDetailIndex == null || !abstracts[primaryDetailIndex]) return null;
    const t = rowTimeMs(abstracts[primaryDetailIndex]);
    return t > 0 ? t : null;
  }, [primaryDetailIndex, abstracts]);

  useEffect(() => {
    if (!timeDomain) return;
    setTlFilter({ min: timeDomain.min, max: timeDomain.max });
  }, [timeDomain?.min, timeDomain?.max]);

  const handleTimelineFilterChange = useCallback((range) => {
    setTlFilter(range);
  }, []);

  const agendaDays = useMemo(() => agendaDaysFromAbstracts(abstracts), [abstracts]);

  const jumpToAgendaDay = useCallback(
    (day) => {
      if (!timeDomain) return;
      const a = Math.max(timeDomain.min, day.startMs);
      const b = Math.min(timeDomain.max, day.endMs);
      if (b <= a) return;
      setTlFilter({ min: a, max: b });
    },
    [timeDomain],
  );

  const clearAgendaTimeFilter = useCallback(() => {
    if (!timeDomain) return;
    setTlFilter({ min: timeDomain.min, max: timeDomain.max });
  }, [timeDomain]);

  const agendaTimeFilterFull = Boolean(
    timeDomain && tlFilter.min <= timeDomain.min + 1000 && tlFilter.max >= timeDomain.max - 1000,
  );

  const activeAgendaDayKey = useMemo(() => {
    if (!timeDomain || agendaTimeFilterFull) return null;
    const span = tlFilter.max - tlFilter.min;
    if (span > 40 * HOUR) return null;
    const mid = (tlFilter.min + tlFilter.max) / 2;
    for (const d of agendaDays) {
      if (mid >= d.startMs && mid <= d.endMs) return d.key;
    }
    return null;
  }, [timeDomain, agendaDays, tlFilter.min, tlFilter.max, agendaTimeFilterFull]);

  useLayoutEffect(() => {
    const el = timelineRailRef.current;
    if (!el) {
      setTimelineRailH(0);
      return;
    }
    const measure = () => setTimelineRailH(el.getBoundingClientRect().height);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [timeDomain, agendaDays.length, narrow, agendaTimeFilterFull]);

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 60000);
    return () => window.clearInterval(id);
  }, []);

  const goToNow = useCallback(() => {
    if (!timeDomain) return;
    const d0 = timeDomain.min;
    const d1 = timeDomain.max;
    const cur = Date.now();
    const mid = Math.min(d1, Math.max(d0, cur));
    const a = Math.max(d0, mid - 90 * MIN);
    const b = Math.min(d1, mid + 270 * MIN);
    setTlFilter({ min: a, max: b });
  }, [timeDomain]);

  useEffect(() => {
    if (!narrow || !timeDomain) return;
    if (didAutoNowRef.current) return;
    didAutoNowRef.current = true;
    goToNow();
  }, [narrow, timeDomain?.min, timeDomain?.max, goToNow]);

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
      <div className="aacr-root" style={{ width: "100vw", height: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: "var(--bg-app)", color: "var(--text-muted)", fontFamily: "var(--font-ui)", position: "relative" }}>
        <style>{`
          @import url('https://fonts.googleapis.com/css2?family=Figtree:ital,wght@0,400..600;1,400&family=Source+Serif+4:ital,opsz,wght@0,8..60,400..600;1,8..60,400&display=swap');
          .aacr-root {
            --font-ui: 'Figtree', system-ui, sans-serif;
            --font-body: 'Source Serif 4', Georgia, serif;
            --bg-app: #080808;
            --text: #e8eaef;
            --text-muted: #8d95a3;
          }
          @keyframes pulse { 0%,100% { opacity: 0.3; } 50% { opacity: 1; } }
        `}</style>
        <div style={{ fontSize: 16, letterSpacing: 6, textTransform: "uppercase", marginBottom: 36, color: "var(--text)", animation: "pulse 2s infinite" }}>AACR 2026 Explorer</div>
        <div style={{ fontSize: 18, fontFamily: "var(--font-body)", color: "var(--text)" }}>{loadingStatus}</div>
      </div>
    );
  }

  return (
    <div className={`aacr-root${narrow ? " aacr-root--narrow" : ""}`} style={{ width: "100vw", height: "100vh", overflow: "hidden", background: "var(--bg-app)", color: "var(--text)", fontFamily: "var(--font-ui)", position: "relative" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Figtree:ital,wght@0,400..600;1,400&family=Source+Serif+4:ital,opsz,wght@0,8..60,400..600;1,8..60,400&display=swap');
        .aacr-root {
          --font-ui: 'Figtree', system-ui, sans-serif;
          --font-body: 'Source Serif 4', Georgia, serif;
          --bg-app: #080808;
          --surface-top: oklch(22% 0.018 260 / 0.98);
          --surface-panel: oklch(20% 0.015 260 / 0.98);
          --surface-float: oklch(21% 0.015 260 / 0.97);
          --surface-dock: oklch(19% 0.014 260 / 0.99);
          --border: oklch(100% 0 0 / 0.12);
          --text: #e8eaef;
          --text-muted: #8d95a3;
          --text-soft: #b4bcc8;
          --input-bg: oklch(100% 0 0 / 0.08);
          --scroll-thumb: oklch(100% 0 0 / 0.14);
          --table-header: oklch(21% 0.014 260 / 0.94);
          --table-row-hover: oklch(100% 0 0 / 0.055);
          --hint-shadow: 0 1px 3px rgba(0,0,0,0.85);
        }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { width: 8px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: var(--scroll-thumb); border-radius: 4px; }
        .top-bar { position: fixed; top: 0; left: 0; right: 0; height: ${TOP_BAR_PX}px; z-index: 50; display: flex; align-items: center; gap: 8px; padding: 0 12px 0 8px; background: var(--surface-top); border-bottom: 1px solid var(--border); }
        .top-bar .logo { font-family: var(--font-ui); font-weight: 700; font-size: 16px; color: var(--text); letter-spacing: 0.18em; text-transform: uppercase; white-space: nowrap; user-select: none; flex-shrink: 0; }
        .top-bar .logo span { color: var(--text-muted); font-weight: 400; }
        .top-bar-search:focus { border-color: color-mix(in oklch, var(--text) 40%, var(--border)); }
        .top-bar-search::placeholder { color: var(--text-muted); }
        .top-bar-tools { display: flex; align-items: center; gap: 6px; flex-shrink: 0; margin-left: auto; min-width: 0; }
        .top-bar-filters { display: flex; align-items: center; gap: 8px; flex-shrink: 1; min-width: 0; }
        .top-bar-search { flex: 1; min-width: 120px; max-width: 520px; background: var(--input-bg); border: 1px solid var(--border); color: var(--text); font-family: var(--font-ui); font-size: 13px; padding: 7px 12px; border-radius: 4px; outline: none; transition: border-color 0.2s; }
        .type-filter-wrap {
          display: inline-flex;
          align-items: stretch;
          flex-shrink: 0;
          border-radius: 5px;
          border: 1px solid var(--border);
          overflow: hidden;
        }
        .type-filter-wrap .ctrl-btn {
          border-radius: 0;
          border: none;
          border-right: 1px solid var(--border);
          margin: 0;
        }
        .type-filter-wrap .ctrl-btn:last-child { border-right: none; }
        .filter-dropdown-wrap { display: flex; align-items: center; gap: 8px; flex-shrink: 0; position: relative; z-index: 55; }
        .filter-dropdown-panel { position: absolute; top: calc(100% + 8px); left: 0; min-width: 300px; max-width: min(420px, calc(100vw - 24px)); max-height: min(72vh, 520px); z-index: 60; display: flex; flex-direction: column; padding: 10px 12px; background: var(--surface-float); border: 1px solid var(--border); border-radius: 6px; box-shadow: 0 12px 40px rgba(0,0,0,0.35); transform-origin: top left; animation: paneDropIn 0.24s cubic-bezier(0.22, 1, 0.36, 1) both; }
        .filter-dropdown-wrap > div:nth-child(2) .filter-dropdown-panel { left: auto; right: 0; transform-origin: top right; }
        .filter-check-list { overflow-y: auto; flex: 1; min-height: 0; margin-top: 8px; max-height: 280px; border: none; border-radius: 6px; padding: 4px 0; background: var(--input-bg); }
        .filter-check-row { display: flex; align-items: flex-start; gap: 8px; padding: 6px 10px; font-size: 12px; color: var(--text-soft); cursor: pointer; }
        .filter-check-row:hover { background: var(--table-row-hover); }
        .filter-check-row input { margin-top: 2px; accent-color: var(--text); flex-shrink: 0; }
        .filter-check-label { flex: 1; line-height: 1.4; min-width: 0; }
        .app-main { position: fixed; z-index: 1; left: 0; display: flex; flex-direction: column; overflow: hidden; }
        .timeline-rail { flex-shrink: 0; background: var(--surface-dock); border-bottom: 1px solid var(--border); z-index: 14; }
        .timeline-rail .table-time-filter { padding: 10px 16px 6px; border-bottom: none; }
        .timeline-rail .table-day-shortcuts { padding: 6px 16px 10px; border-bottom: none; }
        .main-vis { flex: 1 1 auto; min-height: 0; position: relative; }
        .main-vis::after {
          content: '';
          position: absolute;
          inset: 0;
          pointer-events: none;
          z-index: 8;
          background: radial-gradient(ellipse 82% 72% at 50% 46%, transparent 32%, rgba(0,0,0,0.22) 62%, rgba(0,0,0,0.68) 100%);
        }
        @media (prefers-reduced-transparency: reduce) {
          .main-vis::after { background: rgba(0,0,0,0.12); }
        }
        .canvas-wrap { position: absolute; inset: 0; z-index: 1; overflow: hidden; }
        .legend-floating { position: absolute; top: 14px; right: 14px; bottom: auto; width: min(300px, calc(100% - 28px)); max-height: min(38vh, calc(100% - 28px)); z-index: 22; background: var(--surface-float); border: none; border-radius: 8px; padding: 12px 14px; display: flex; flex-direction: column; box-shadow: 0 10px 36px rgba(0,0,0,0.38), 0 0 0 1px color-mix(in oklch, var(--border) 55%, transparent); animation: legendPaneIn 0.28s cubic-bezier(0.22, 1, 0.36, 1) both; }
        .legend-tab { position: absolute; top: 14px; right: 14px; bottom: auto; z-index: 22; background: var(--surface-float); border: none; color: var(--text-soft); font-family: var(--font-ui); font-size: 11px; padding: 8px 12px; border-radius: 6px; cursor: pointer; letter-spacing: 0.04em; text-transform: uppercase; box-shadow: 0 6px 22px rgba(0,0,0,0.32), 0 0 0 1px color-mix(in oklch, var(--border) 50%, transparent); animation: legendPaneIn 0.28s cubic-bezier(0.22, 1, 0.36, 1) both; }
        .hints { position: absolute; top: 14px; left: 14px; right: auto; bottom: auto; z-index: 24; text-align: left; user-select: none; max-width: min(520px, 78vw); pointer-events: none; text-shadow: var(--hint-shadow); }
        .table-dock-wrap { flex-shrink: 0; display: flex; flex-direction: column; min-height: 0; }
        .table-dock { display: flex; flex-direction: column; border-top: 1px solid var(--border); background: var(--surface-dock); box-shadow: 0 -6px 24px rgba(0,0,0,0.22); z-index: 12; }
        .table-dock .table-panel { width: 100%; max-height: none; }
        .table-time-filter { padding: 10px 16px 6px; flex-shrink: 0; }
        .table-day-shortcuts { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 8px 16px 10px; flex-shrink: 0; }
        .table-time-filter-label { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 6px; min-height: 26px; font-size: 12px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-muted); }
        .table-time-clear { padding: 3px 9px !important; font-size: 11px !important; font-weight: 500; line-height: 1.25; min-height: 0 !important; flex-shrink: 0; }
        .table-time-clear--concealed { visibility: hidden; pointer-events: none; }
        .table-time-filter-map-surface { width: 100%; display: flex; flex-direction: column; position: relative; }
        .table-time-filter-axis { position: relative; width: 100%; padding-top: 10px; }
        .table-time-filter-vrules { position: absolute; left: 0; right: 0; top: 10px; bottom: 0; pointer-events: none; z-index: 1; }
        .table-time-filter-vrule { position: absolute; top: 0; bottom: 0; width: 0; margin-left: -0.5px; background: none; pointer-events: none; }
        .table-time-filter-vrule--day { border-left: 2px solid rgba(200, 214, 228, 0.88); margin-left: -1px; }
        .table-time-filter-vrule--hour { border-left: 1px dotted rgba(140, 175, 220, 0.78); }
        .table-time-filter-vrule--sub { border-left: 1px dashed rgba(255, 255, 255, 0.28); }
        .table-time-filter-tickstrip { position: relative; height: 16px; margin-bottom: 6px; font-size: 12px; color: var(--text-muted); pointer-events: none; z-index: 2; }
        .table-time-filter-tick { position: absolute; top: 0; transform: translateX(-50%); max-width: 76px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .table-time-filter-track { position: relative; height: 28px; background: rgba(0,0,0,0.34); border-radius: 4px; border: none; touch-action: none; z-index: 2; }
        .table-time-filter-track:focus-visible { outline: 2px solid color-mix(in oklch, var(--text) 55%, oklch(55% 0.2 250)); outline-offset: 2px; }
        .table-time-filter-heatmap-wrap { position: absolute; inset: 0; pointer-events: none; z-index: 0; border-radius: 3px; overflow: hidden; }
        .table-time-filter-heatcell { position: absolute; top: 0; bottom: 0; box-sizing: border-box; border-right: 1px solid rgba(0,0,0,0.18); }
        .table-time-filter-occ-layer { position: absolute; inset: 0; pointer-events: none; z-index: 3; }
        .table-time-filter-occ { position: absolute; top: 0; bottom: 0; width: 0; margin-left: -0.5px; border-left: 1px solid rgba(120, 195, 255, 0.55); }
        .table-time-filter-occ--selected { border-left: 2px solid rgba(255, 217, 61, 0.92); margin-left: -1px; z-index: 1; }
        .table-time-filter-now { position: absolute; top: 0; bottom: 0; width: 0; margin-left: -1px; border-left: 2px solid rgba(120, 195, 255, 0.92); box-shadow: 0 0 0 1px rgba(0,0,0,0.25); z-index: 2; }
        .table-time-filter-now::after { content: "Now"; position: absolute; top: -18px; left: 6px; font-size: 10px; letter-spacing: 0.06em; color: rgba(232,234,239,0.9); background: rgba(0,0,0,0.45); border: none; border-radius: 6px; padding: 2px 6px; }
        .table-time-filter-brush { position: absolute; top: 0; bottom: 0; background: rgba(212,212,216,0.14); border-left: none; border-right: none; pointer-events: none; box-sizing: border-box; z-index: 2; box-shadow: inset 0 0 0 1px rgba(212,212,216,0.22); }
        .table-time-filter-brush--preview { background: rgba(212,212,216,0.1); box-shadow: inset 0 0 0 1px rgba(212,212,216,0.4); }
        .table-time-cursor-hint {
          pointer-events: none;
          font-family: 'Figtree', system-ui, sans-serif;
          font-size: 12px;
          line-height: 1.35;
          font-weight: 500;
          color: #e8eaef;
          background: oklch(21% 0.015 260);
          border: none;
          padding: 6px 10px;
          border-radius: 6px;
          white-space: nowrap;
          box-shadow: 0 6px 22px rgba(0,0,0,0.48), 0 0 0 1px color-mix(in oklch, var(--border) 40%, transparent);
        }
        .table-time-filter-ticks { display: flex; justify-content: space-between; align-items: flex-start; margin-top: 8px; font-size: 12px; color: var(--text-muted); gap: 8px; }
        .table-time-edge { flex: 0 1 42%; min-width: 0; line-height: 1.35; }
        .table-time-edge:first-child { text-align: left; }
        .table-time-edge:last-child { text-align: right; }
        .table-time-filter-hint { opacity: 0.85; font-size: 11px; letter-spacing: 0.02em; text-align: center; flex: 1; min-width: 120px; line-height: 1.45; }
        .table-body th.table-sortable { cursor: pointer; user-select: none; }
        .table-body th.table-sortable:hover { color: var(--text); }
        .table-body th.table-sort-active { color: var(--text); }

        .ctrl-btn { background: var(--input-bg); border: 1px solid var(--border); color: var(--text-soft); font-family: var(--font-ui); font-size: 12px; padding: 6px 10px; border-radius: 4px; cursor: pointer; transition: background 0.15s, border-color 0.15s, color 0.15s; white-space: nowrap; }
        .ctrl-btn:hover { background: var(--table-row-hover); border-color: color-mix(in oklch, var(--text) 28%, var(--border)); color: var(--text); }
        .ctrl-btn.active { background: color-mix(in oklch, var(--text) 12%, var(--input-bg)); border-color: color-mix(in oklch, var(--text) 35%, var(--border)); color: var(--text); }
        .ctrl-btn:focus-visible, .close-btn:focus-visible, .fav-btn:focus-visible, .export-drop-trigger:focus-visible { outline: 2px solid color-mix(in oklch, var(--text) 55%, oklch(55% 0.2 250)); outline-offset: 2px; }
        .export-drop { position: relative; flex-shrink: 0; z-index: 56; }
        .export-drop > summary.export-drop-trigger { list-style: none; }
        .export-drop > summary.export-drop-trigger::-webkit-details-marker { display: none; }
        .export-drop-panel {
          position: absolute;
          top: calc(100% + 6px);
          right: 0;
          z-index: 60;
          display: flex;
          flex-direction: column;
          gap: 4px;
          min-width: 200px;
          padding: 8px;
          background: var(--surface-float);
          border: 1px solid var(--border);
          border-radius: 6px;
          box-shadow: 0 12px 40px rgba(0,0,0,0.35);
        }
        .export-drop-opt { width: 100%; justify-content: flex-start; text-align: left; }
        .filter-dropdown-wrap .ctrl-btn { background: color-mix(in oklch, var(--input-bg) 65%, transparent); }
        @media (prefers-reduced-motion: reduce) {
          .fav-btn { transition: none; }
          .fav-btn:hover { transform: none; }
        }
        .filter-q { width: 100%; margin-top: 4px; }
        .filter-q:focus { border-color: color-mix(in oklch, var(--text) 35%, var(--border)); }
        .filter-hint { font-size: 12px; color: var(--text-muted); margin-top: 6px; }
        .filter-pick-list { max-height: 100px; overflow-y: auto; border: 1px solid rgba(255,255,255,0.1); border-radius: 4px; margin-top: 4px; background: rgba(0,0,0,0.12); }
        .filter-pick-row { padding: 5px 8px; font-size: 11px; cursor: pointer; color: #b0b8c4; border-bottom: 1px solid rgba(255,255,255,0.06); line-height: 1.3; }
        .filter-pick-row:hover { background: rgba(212,212,216,0.065); color: #f0f2f5; }
        .filter-pick-row.active { color: #d4d4d8; }
        .detail-float-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-shrink: 0; padding: 14px 16px 12px; border-bottom: 1px solid color-mix(in oklch, var(--border) 48%, transparent); }
        .detail-float-title { font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-muted); font-weight: 600; min-width: 0; line-height: 1.35; }
        .detail-head-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
        .detail-float .close-btn { width: 34px; height: 34px; flex-shrink: 0; border-radius: 6px; font-size: 17px; line-height: 1; }
        .detail-multi-list { list-style: none; margin: 0; padding: 0; max-height: 140px; overflow-y: auto; border: none; background: transparent; }
        .detail-multi-pick { display: block; width: 100%; text-align: left; padding: 9px 10px; border: none; border-bottom: 1px solid color-mix(in oklch, var(--border) 35%, transparent); background: transparent; color: var(--text-soft); font-family: var(--font-ui); font-size: 12px; line-height: 1.4; cursor: pointer; border-radius: 0; transition: background 0.12s ease-out, color 0.12s ease-out; }
        .detail-multi-pick:last-child { border-bottom: none; }
        .detail-multi-pick:hover { background: var(--table-row-hover); color: var(--text); }
        .detail-multi-pick:focus-visible { outline: 2px solid color-mix(in oklch, var(--text) 55%, oklch(55% 0.2 250)); outline-offset: 2px; }
        .detail-main { font-family: inherit; }
        .detail-main h2 { font-family: var(--font-body); font-size: 18px; font-weight: 600; color: var(--text); line-height: 1.35; margin: 0 0 10px; letter-spacing: -0.012em; clear: both; }
        .detail-lede { font-size: 12px; color: var(--text-muted); line-height: 1.5; margin-bottom: 12px; }
        .detail-meta { font-size: 13px; color: var(--text-soft); margin-bottom: 8px; line-height: 1.55; }
        .detail-meta b { color: var(--text); font-weight: 500; }
        .detail-topic-pill { display: inline-block; font-size: 11px; font-weight: 500; letter-spacing: 0.03em; padding: 2px 7px; border-radius: 4px; border: none; color: var(--topic-color, var(--text)); background: color-mix(in oklch, var(--topic-color, var(--text)) 16%, var(--input-bg)); vertical-align: 0.12em; margin-left: 4px; max-width: 100%; }
        .legend-item .topic-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .detail-abstract { font-family: var(--font-body); font-size: 14px; line-height: 1.72; color: var(--text-soft); margin-top: 18px; white-space: pre-wrap; border-top: 1px solid color-mix(in oklch, var(--border) 42%, transparent); padding-top: 16px; max-width: 65ch; }
        .fav-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; background: color-mix(in oklch, #ffd93d 8%, transparent); border: 1px solid color-mix(in oklch, #ffd93d 28%, var(--border)); color: #ffd93d; font-family: var(--font-ui); font-size: 12px; font-weight: 600; padding: 7px 14px; border-radius: 4px; cursor: pointer; transition: background 0.15s, border-color 0.15s, transform 0.12s ease-out; margin-top: 12px; }
        .fav-btn--compact { margin-top: 0; padding: 5px 11px; font-size: 11px; min-height: 34px; }
        .fav-btn:hover { background: color-mix(in oklch, #ffd93d 14%, transparent); transform: scale(1.02); }
        .fav-btn.is-fav { background: color-mix(in oklch, #ffd93d 16%, transparent); border-color: color-mix(in oklch, #ffd93d 42%, var(--border)); }
        .close-btn { background: var(--input-bg); border: none; color: var(--text-muted); display: flex; align-items: center; justify-content: center; border-radius: 4px; cursor: pointer; font-size: 18px; transition: background 0.15s, color 0.15s; }
        .close-btn:hover { background: color-mix(in oklch, #e85d5d 14%, var(--input-bg)); color: #e85d5d; }
        .detail-empty { color: var(--text-muted); font-size: 12px; line-height: 1.65; padding: 16px 0; }

        .legend-floating .legend-scroll { overflow-y: auto; flex: 1; min-height: 0; margin-top: 6px; }
        .legend-floating h4 { font-size: 12px; color: var(--text-muted); letter-spacing: 0.06em; text-transform: uppercase; margin: 0; font-weight: 600; }
        .legend-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-shrink: 0; }
        .legend-collapse { background: none; border: none; color: #a8b0bc; cursor: pointer; font-size: 18px; line-height: 1; padding: 2px 6px; border-radius: 4px; }
        .legend-collapse:hover { color: #d4d4d8; }

        .legend-tab:hover { color: #d4d4d8; box-shadow: 0 8px 26px rgba(0,0,0,0.36), 0 0 0 1px color-mix(in oklch, var(--border) 62%, transparent); }
        .legend-item { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--text-soft); margin-bottom: 4px; cursor: pointer; transition: color 0.15s; }
        .legend-item:hover { color: var(--text); }
        .topic-cell { display: inline-flex; align-items: center; gap: 6px; min-width: 0; max-width: 100%; }
        .topic-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .legend-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
        .legend-count { color: var(--text-muted); margin-left: auto; font-size: 12px; }
        .table-panel { background: transparent; display: flex; flex-direction: column; min-height: 0; }
        .table-panel-main { display: flex; flex-direction: column; flex: 1; min-height: 0; }
        @keyframes paneDropIn { from { opacity: 0; transform: translateY(-8px) scale(0.98); } to { opacity: 1; transform: translateY(0) scale(1); } }
        @keyframes legendPaneIn { from { opacity: 0; transform: translateY(-10px); } to { opacity: 1; transform: translateY(0); } }
        .table-resize-handle { height: 6px; cursor: ns-resize; background: transparent; flex-shrink: 0; display: flex; align-items: center; justify-content: center; }
        .table-resize-handle::after { content: ''; width: 40px; height: 3px; border-radius: 2px; background: rgba(255,255,255,0.18); }
        .table-resize-handle:hover::after { background: rgba(212,212,216,0.34); }
        .table-header { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 16px; border-bottom: 1px solid rgba(255,255,255,0.1); flex-shrink: 0; }
        .table-header span { font-size: 12px; color: var(--text-muted); letter-spacing: 0.06em; text-transform: uppercase; }
        .table-header-tools { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
        .table-body { overflow-y: auto; flex: 1; }
        .table-body table { width: 100%; border-collapse: collapse; font-size: 12px; }
        .table-body th { position: sticky; top: 0; background: var(--table-header); color: var(--text-muted); font-weight: 600; text-align: left; padding: 9px 12px; border-bottom: 1px solid color-mix(in oklch, var(--border) 65%, transparent); font-size: 12px; letter-spacing: 0.04em; text-transform: uppercase; white-space: nowrap; }
        .table-body td { padding: 9px 12px; border-bottom: 1px solid var(--border); color: var(--text-soft); max-width: 400px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .table-body tr { cursor: pointer; transition: background 0.1s; }
        .table-body tr:hover { background: var(--table-row-hover); }
        .table-body tr:hover td { color: var(--text); }
        .table-body tr.is-selected { background: color-mix(in oklch, var(--text) 9%, transparent); }
        .table-body tr.is-selected td { color: var(--text); }
        .table-body tr.table-agenda-date td { background: var(--table-row-hover); color: var(--text); font-size: 12px; letter-spacing: 0.06em; text-transform: uppercase; font-weight: 600; border-bottom: 1px solid var(--border); cursor: default; }
        .table-body tr.table-agenda-date:hover { background: transparent; }
        .hints p { font-size: 12px; color: var(--text-muted); letter-spacing: 0.03em; line-height: 1.55; }
        .hints p b { color: var(--text-soft); font-weight: 600; }
        .stat { font-size: 12px; color: var(--text-muted); letter-spacing: 0.04em; text-transform: uppercase; white-space: nowrap; }
        .stat b { color: var(--text); font-weight: 600; }
        .stat-sep { font-weight: 400; opacity: 0.85; }
        .detail-float { position: fixed; z-index: 40; display: flex; flex-direction: column; background: color-mix(in oklch, var(--surface-float) 91%, transparent); border: none; border-radius: 12px; box-shadow: 0 20px 56px rgba(0,0,0,0.42), 0 0 0 1px color-mix(in oklch, var(--border) 38%, transparent); overflow: hidden; backdrop-filter: blur(14px) saturate(1.12); -webkit-backdrop-filter: blur(14px) saturate(1.12); }
        @media (prefers-reduced-transparency: reduce) {
          .detail-float { background: var(--surface-float); backdrop-filter: none; -webkit-backdrop-filter: none; }
        }
        .detail-float-body { overflow-y: auto; padding: 4px 18px 18px; scroll-padding-bottom: 12px; }
        .detail-float-body:has(.detail-multi-list) .detail-multi-list { margin-top: 0; padding-top: 10px; }
        .aacr-root--narrow .top-bar {
          display: grid;
          grid-template-columns: 1fr auto;
          grid-auto-rows: auto;
          height: auto;
          min-height: ${TOP_BAR_PX}px;
          align-content: start;
          padding: 8px 10px;
          column-gap: 10px;
          row-gap: 8px;
        }
        .aacr-root--narrow .logo { grid-column: 1; grid-row: 1; justify-self: start; align-self: center; }
        .aacr-root--narrow .top-bar-tools { grid-column: 2; grid-row: 1; margin-left: 0; justify-self: end; flex-wrap: wrap; max-width: 100%; }
        .aacr-root--narrow .top-bar-search { grid-column: 1 / -1; grid-row: 2; width: 100%; max-width: none; min-height: 44px; font-size: 16px; }
        .aacr-root--narrow .top-bar-filters { grid-column: 1 / -1; grid-row: 3; flex-wrap: wrap; width: 100%; align-items: flex-start; }
        .aacr-root--narrow .type-filter-wrap { flex-basis: 100%; justify-content: flex-start; }
        .aacr-root--narrow .ctrl-btn { min-height: 40px; }
        .aacr-root--narrow .table-body td.cell-fav { min-width: 48px; min-height: 44px; vertical-align: middle; }
      `}</style>

      <header className="top-bar">
        <div className="logo">AACR<span>.</span>2026</div>
        <input
          ref={searchInputRef}
          type="search"
          className="top-bar-search"
          placeholder="Search… (press /)"
          title="Search titles, topics, and sessions. Press / to focus."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
        />
        <div className="top-bar-filters">
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
        </div>
        <div className="top-bar-tools">
          <span
            className="stat"
            title={
              filteredIndices.length === abstracts.length
                ? "All abstracts in view"
                : `${filteredIndices.length.toLocaleString()} of ${abstracts.length.toLocaleString()} match your filters`
            }
          >
            {filteredIndices.length === abstracts.length ? (
              <b>{abstracts.length.toLocaleString()}</b>
            ) : (
              <>
                <b>{filteredIndices.length.toLocaleString()}</b>
                <span className="stat-sep"> / </span>
                {abstracts.length.toLocaleString()}
              </>
            )}
          </span>
          {narrow ? (
            <>
              <button type="button" className="ctrl-btn" onClick={goToNow} title="Show current time on the timeline">Now</button>
              <button type="button" className={`ctrl-btn ${autoRotate ? "active" : ""}`} onClick={() => setAutoRotate((v) => !v)}>Spin</button>
              <button type="button" className="ctrl-btn" onClick={handleReset}>Reset</button>
            </>
          ) : (
            <>
              <button type="button" className={`ctrl-btn ${autoRotate ? "active" : ""}`} onClick={() => setAutoRotate((v) => !v)}>Spin</button>
              <button type="button" className="ctrl-btn" onClick={handleReset}>Reset</button>
              <ExportDropMenu onExport={exportIcs} />
            </>
          )}
        </div>
      </header>

      {selectedIndices.length > 0 ? (
        <div
          className="detail-float"
          style={
            narrow
              ? {
                  left: 12,
                  right: 12,
                  bottom: tableHeight + 10,
                  top: "auto",
                  maxHeight: "min(42vh, calc(100vh - 120px))",
                }
              : {
                  right: 14,
                  top: layoutTopPx + timelineRailH + 12,
                  maxHeight: `calc(100vh - ${layoutTopPx + timelineRailH + 12}px - ${tableHeight}px - 18px)`,
                  width: "min(420px, calc(100vw - 28px))",
                }
          }
          role="dialog"
          aria-label="Abstract details"
        >
          <div className="detail-float-head">
            <div className="detail-float-title">
              {selectedIndices.length > 1 ? `Pick an abstract · ${selectedIndices.length}` : "Abstract"}
            </div>
            <div className="detail-head-actions">
              {selected && selectedIndices.length === 1 ? (
                <button
                  type="button"
                  className={`fav-btn fav-btn--compact ${activeListIds.has(selected.id) ? "is-fav" : ""}`}
                  onClick={() => toggleFavorite(selected.id)}
                  aria-label={activeListIds.has(selected.id) ? "Remove from favorites" : "Add to favorites"}
                >
                  {activeListIds.has(selected.id) ? "Saved" : "Save"}
                </button>
              ) : null}
              <button type="button" className="close-btn" title="Clear selection" aria-label="Dismiss details" onClick={() => setSelectedIndices([])}>×</button>
            </div>
          </div>
          <div className="detail-float-body">
            {selectedIndices.length > 1 ? (
              <ul className="detail-multi-list">
                {selectedIndices.map((idx) => {
                  const a = abstracts[idx];
                  if (!a) return null;
                  return (
                    <li key={idx}>
                      <button type="button" className="detail-multi-pick" onClick={() => focusSingleIndex(idx)}>
                        {a.title}
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : null}
            {selected ? (
              <div className="detail-main" style={{ marginTop: selectedIndices.length > 1 ? 12 : 2 }}>
                <h2>{selected.title}</h2>
                <div className="detail-lede">
                  #{selected.id} · {selected.type === "talk" ? "Talk" : `Poster ${selected.posterNumber}`} · {formatAbstractTimeLabel(selected.start)}
                </div>
                <AffiliationView institution={selected.institution} authors={selected.authors} presenter={selected.presenter} />
                <div className="detail-meta">
                  <b>Session</b> {selected.session}
                  {selected.clusterTopic ? (
                    <>
                      {" "}
                      <span
                        className="detail-topic-pill"
                        style={{ "--topic-color": displayTopicCssColor(topicColors[selected.clusterTopic]) }}
                      >
                        {selected.clusterTopic}
                      </span>
                    </>
                  ) : null}
                </div>
                {selected.abstract ? <div className="detail-abstract">{selected.abstract}</div> : null}
              </div>
            ) : (
              <div className="detail-empty" style={{ paddingTop: 8 }}>Nothing to show for this selection.</div>
            )}
          </div>
        </div>
      ) : null}

      <div
        className="app-main"
        style={{
          top: layoutTopPx,
          left: 0,
          right: 0,
          bottom: 0,
        }}
      >
        {timeDomain ? (
          <div className="timeline-rail" ref={timelineRailRef}>
            <TableTimeFilterBar
              domain={timeDomain}
              filterMin={tlFilter.min}
              filterMax={tlFilter.max}
              onFilterChange={handleTimelineFilterChange}
              onClearFilter={() => {
                if (!timeDomain) return;
                setTlFilter({ min: timeDomain.min, max: timeDomain.max });
              }}
              heatmapStats={heatmapStats}
              occurrenceMarkerTimes={occurrenceMarkerTimes}
              selectedTimeMs={selectedTimeMsForTimeline}
              nowMs={nowMs}
            />
            {agendaDays.length > 0 ? (
              <div className="table-day-shortcuts">
                <button
                  type="button"
                  className={`ctrl-btn${agendaTimeFilterFull ? " active" : ""}`}
                  onClick={clearAgendaTimeFilter}
                  title="Show every conference day on the timeline"
                >
                  All days
                </button>
                {agendaDays.map((day) => (
                  <button
                    key={day.key}
                    type="button"
                    className={`ctrl-btn${activeAgendaDayKey === day.key ? " active" : ""}`}
                    onClick={() => jumpToAgendaDay(day)}
                    title={`Jump to ${day.label} (your local time)`}
                  >
                    {day.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
        <div className="main-vis">
          <div className="canvas-wrap">
            <Canvas
              camera={{ position: [0, 0, 1], fov: 60, near: 0.01, far: 100 }}
              style={{ width: "100%", height: "100%", display: "block" }}
              gl={{ antialias: true }}
            >
              <color attach="background" args={["#080808"]} />
              <ScatterRendererTuning narrow={narrow} />
              <PointCloud
                abstracts={abstracts}
                embeddings={embeddings}
                filteredSet={mapVisualActiveSet}
                pickIndices={scatterFocusIndices}
                searchSimilarity={searchSimilarity}
                clusterColors={clusterColors}
                topicColors={topicColors}
                topicFilterSelected={topicFilterSelected}
                selectedIndices={selectedIndices}
                onSelect={applySelection}
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
              <SmoothZoom
                minDist={ZOOM_MIN}
                maxDist={ZOOM_MAX}
                orbitControlsRef={orbitControlsRef}
                wheelResetKey={scatterHomeViewNonce}
              />
              <ScatterPostFX enabled={!narrow && !reducedMotion} />
              <SelectionCameraRig
                orbitControlsRef={orbitControlsRef}
                cameraFocusPayload={cameraFocusPayload}
                payloadKey={selectionCameraKey}
                homeGeometry={mapHomeGeometry}
                homeViewResetNonce={scatterHomeViewNonce}
              />
              <GizmoHelper alignment="bottom-right" margin={[72, 168]}>
                <GizmoViewport axisColors={["#b09090", "#b0b0b4", "#9098a0"]} labelColor="#d0d0d4" />
              </GizmoHelper>
            </Canvas>

          </div>

          {legendExpanded ? (
            <div className="legend-floating">
              <div className="legend-head">
                <h4>Topic clusters</h4>
                <button type="button" className="legend-collapse" aria-label="Collapse legend" onClick={() => setLegendExpanded(false)}>−</button>
              </div>
              <div className="legend-scroll">
                {clusterTopics.map(({ topic, count }) => (
                  <div key={topic} className="legend-item" onClick={() => toggleTopicFilter(topic)}>
                    <div className="legend-dot" style={{ background: topicColors[topic] }} />
                    <span
                      className="topic-name"
                      style={topicFilterSelected.has(topic) ? { color: displayTopicCssColor(topicColors[topic]) } : {}}
                    >
                      {topic}
                    </span>
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
            <p><b>/</b> FOCUS SEARCH</p>
          </div>
        </div>

        <div className="table-dock-wrap">
          <div className="table-dock">
            <div className="table-panel" style={{ height: tableHeight }} onClick={(e) => e.stopPropagation()}>
              <div className="table-resize-handle" onMouseDown={handleTableResizeStart} />
              <div className="table-panel-main">
              <div className="table-header">
                <span>Abstracts ({sortedTableAbstracts.length})</span>
                <div className="table-header-tools">
                  <button
                    type="button"
                    className={`ctrl-btn${showFavoritesOnly ? " active" : ""}`}
                    onClick={() => setShowFavoritesOnly((v) => !v)}
                    title="Show only favorited rows in the table and map"
                  >
                    Favorites ({favoriteIds.length})
                  </button>
                  {narrow ? <ExportDropMenu onExport={exportIcs} /> : null}
                </div>
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
                      const absIdx = abstracts.findIndex((x) => x.id === a.id);
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
                        <tr
                          key={a.id + String(a.internalId)}
                          className={absIdx >= 0 && selectedSet.has(absIdx) ? "is-selected" : ""}
                          onClick={() => {
                            if (absIdx >= 0) applySelection(absIdx);
                          }}
                        >
                          <td style={{ whiteSpace: "nowrap", color: a.type === "talk" ? "#b8bcc2" : "#a8b0bc", textTransform: "uppercase", fontSize: 10, letterSpacing: 1 }}>{a.type || "poster"}</td>
                          <td style={{ whiteSpace: "nowrap", color: "#b0b8c4" }}>{formatAbstractTimeLabel(a.start)}</td>
                          <td style={{ whiteSpace: "nowrap", color: "#a8b0bc" }}>{a.posterNumber || "—"}</td>
                          <td style={{ color: "#e4e7ed", maxWidth: 280 }}>{a.title}</td>
                          <td style={{ maxWidth: 180 }}>{a.session}</td>
                          <td className="cell-topic" style={{ maxWidth: 200 }}>
                            <span className="topic-cell">
                              <span className="topic-name" style={{ color: displayTopicCssColor(topicColors[a.clusterTopic]) }}>{a.clusterTopic}</span>
                            </span>
                          </td>
                          <td className="cell-fav" style={{ textAlign: "center", cursor: "pointer" }} onClick={(e) => { e.stopPropagation(); toggleFavorite(a.id); }}>
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
