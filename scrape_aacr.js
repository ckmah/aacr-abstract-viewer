#!/usr/bin/env node
/**
 * AACR 2026 Abstract Scraper
 * ===========================
 * Scrapes poster AND oral/talk session abstracts from abstractsonline.com (pp8 platform).
 *
 * Usage:
 *   node scrape_aacr.js
 *
 * Output:
 *   aacr_abstracts.json — array of abstract objects ready for the explorer app
 *                         Each abstract has a `type` field: "poster" or "talk"
 *
 * Prerequisites:
 *   npm install node-fetch (if Node < 18; Node 18+ has fetch built-in)
 *
 * The pp8 platform (by CTI Meeting Technology) exposes a REST API that
 * the single-page app calls. We replicate those calls directly.
 */

const fs = require("fs");

const BASE = "https://www.abstractsonline.com/pp8";
const MEETING_ID = "21436"; // AACR 2026 Annual Meeting

// pp8 API endpoints (reverse-engineered from the SPA)
const API = {
  // List all sessions, optionally filtered by type
  sessions: `${BASE}/api/sessions/${MEETING_ID}`,
  // List presentations (abstracts) within a session
  presentations: (sessionId) =>
    `${BASE}/api/presentations/${MEETING_ID}/${sessionId}`,
  // Get full abstract detail
  abstractDetail: (presentationId) =>
    `${BASE}/api/presentation/${MEETING_ID}/${presentationId}`,
  // Search all abstracts
  search: (query, page = 1) =>
    `${BASE}/api/search/${MEETING_ID}?q=${encodeURIComponent(query)}&page=${page}`,
  // List all abstracts for the meeting by session type
  sessionsByType: (type) =>
    `${BASE}/api/sessions/${MEETING_ID}?sessionType=${encodeURIComponent(type)}`,
};

const HEADERS = {
  Accept: "application/json, text/plain, */*",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Referer: `${BASE}/#!/${MEETING_ID}/sessions`,
  Origin: "https://www.abstractsonline.com",
};

// Rate limiting
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJSON(url) {
  console.log(`  GET ${url.replace(BASE, "")}`);
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  return res.json();
}

/**
 * Fetch all sessions for a given type label, with fallback to all-sessions filtering.
 * Returns array of session objects, each annotated with `_type` ("poster" or "talk").
 */
async function fetchSessionsOfType(typeString, typeLabel) {
  let sessions;
  try {
    sessions = await fetchJSON(API.sessionsByType(typeString));
    if (!Array.isArray(sessions) || sessions.length === 0) {
      throw new Error("Empty result");
    }
    console.log(`  Found ${sessions.length} "${typeString}" sessions via type filter`);
  } catch (e) {
    console.log(`  Type filter "${typeString}" failed (${e.message})`);
    return null;
  }
  sessions.forEach((s) => { s._type = typeLabel; });
  return sessions;
}

/**
 * Fetch presentations for a list of sessions and collect them all.
 */
async function fetchPresentationsForSessions(sessions) {
  const allPresentations = [];
  for (const session of sessions) {
    const sid = session.SessionId || session.sessionId || session.Id || session.id;
    const sTitle = session.Title || session.title || `Session ${sid}`;
    const sType = session._type || "poster";

    try {
      const presentations = await fetchJSON(API.presentations(sid));
      if (Array.isArray(presentations)) {
        presentations.forEach((p) => {
          p._sessionTitle = sTitle;
          p._sessionId = sid;
          p._type = sType;
        });
        allPresentations.push(...presentations);
        console.log(`  ${sTitle}: ${presentations.length} abstracts`);
      }
    } catch (e) {
      console.log(`  ${sTitle}: FAILED (${e.message})`);
    }
    await delay(300); // Be polite
  }
  return allPresentations;
}

async function main() {
  console.log("=== AACR 2026 Abstract Scraper ===\n");
  console.log("Scraping BOTH poster sessions AND oral/talk sessions.\n");

  // ── Step 1: Get poster sessions ──────────────────────────────────────────────
  console.log("[1/4] Fetching poster sessions...");
  let posterSessions = await fetchSessionsOfType("Poster Session", "poster");

  if (!posterSessions) {
    // Fallback: fetch all and filter client-side
    console.log("  Trying full session list, filtering for posters...");
    try {
      const all = await fetchJSON(API.sessions);
      if (Array.isArray(all)) {
        posterSessions = all.filter(
          (s) =>
            s.SessionType?.toLowerCase().includes("poster") ||
            s.sessionType?.toLowerCase().includes("poster") ||
            s.Title?.toLowerCase().includes("poster") ||
            s.title?.toLowerCase().includes("poster")
        );
        posterSessions.forEach((s) => { s._type = "poster"; });
        console.log(`  Found ${posterSessions.length} poster sessions via full list`);
      }
    } catch (e2) {
      console.error(`  Failed to fetch sessions: ${e2.message}`);
      posterSessions = [];
    }
  }

  // ── Step 2: Get talk/oral sessions ───────────────────────────────────────────
  console.log("\n[2/4] Fetching oral/talk sessions...");

  // AACR uses various names for oral/talk sessions; try them in order
  const TALK_SESSION_TYPES = [
    "Oral Session",
    "Mini Symposium",
    "Regular Abstracts",
    "Educational Session",
    "Special Session",
    "Clinical Trials Plenary Session",
    "Symposia",
  ];

  let talkSessions = [];
  const foundByType = new Map(); // sessionId -> session, to deduplicate

  for (const typeStr of TALK_SESSION_TYPES) {
    const sessions = await fetchSessionsOfType(typeStr, "talk");
    if (sessions && sessions.length > 0) {
      for (const s of sessions) {
        const sid = s.SessionId || s.sessionId || s.Id || s.id;
        if (!foundByType.has(sid)) {
          foundByType.set(sid, s);
        }
      }
    }
    await delay(200);
  }

  if (foundByType.size > 0) {
    talkSessions = [...foundByType.values()];
    console.log(`  Found ${talkSessions.length} unique talk/oral sessions across all types`);
  } else {
    // Fallback: fetch all sessions and exclude poster sessions
    console.log("  No talk sessions found via type filters. Fetching all sessions and filtering...");
    try {
      const all = await fetchJSON(API.sessions);
      if (Array.isArray(all)) {
        const posterIds = new Set(
          (posterSessions || []).map((s) => s.SessionId || s.sessionId || s.Id || s.id)
        );
        talkSessions = all.filter((s) => {
          const sid = s.SessionId || s.sessionId || s.Id || s.id;
          const type = (s.SessionType || s.sessionType || "").toLowerCase();
          const title = (s.Title || s.title || "").toLowerCase();
          // Exclude poster sessions
          if (posterIds.has(sid)) return false;
          if (type.includes("poster") || title.includes("poster")) return false;
          return true;
        });
        talkSessions.forEach((s) => { s._type = "talk"; });
        console.log(`  Found ${talkSessions.length} non-poster sessions (treating as talks)`);
      }
    } catch (e) {
      console.error(`  Failed to fetch all sessions: ${e.message}`);
      talkSessions = [];
    }
  }

  const allSessions = [...(posterSessions || []), ...talkSessions];
  console.log(`\n  Total sessions to process: ${allSessions.length} (${(posterSessions || []).length} poster + ${talkSessions.length} talk)\n`);

  if (allSessions.length === 0) {
    console.log("No sessions found via session API, trying search...");
    await scrapeViaSearch();
    return;
  }

  // ── Step 3: Get presentations for each session ────────────────────────────────
  console.log("[3/4] Fetching presentations per session...");
  const allPresentations = await fetchPresentationsForSessions(allSessions);
  console.log(`\n  Total presentations found: ${allPresentations.length}\n`);

  // ── Step 4: Fetch full abstract details ───────────────────────────────────────
  console.log("[4/4] Fetching full abstract details...");
  const abstracts = [];
  let fetched = 0;

  for (const pres of allPresentations) {
    const pid =
      pres.PresentationId ||
      pres.presentationId ||
      pres.Id ||
      pres.id ||
      pres.AbstractId ||
      pres.abstractId;

    try {
      const detail = await fetchJSON(API.abstractDetail(pid));
      abstracts.push(normalizeAbstract(detail, pres, pres._type || "poster"));
      fetched++;
      if (fetched % 25 === 0)
        console.log(`  Progress: ${fetched}/${allPresentations.length}`);
    } catch (e) {
      // If detail endpoint fails, use the listing data
      abstracts.push(normalizeAbstract(pres, pres, pres._type || "poster"));
    }
    await delay(200);
  }

  writeOutput(abstracts);
}

/**
 * Fallback: use the search API to paginate through all abstracts
 */
async function scrapeViaSearch() {
  console.log("[Search fallback] Paginating through all abstracts...\n");
  const abstracts = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    try {
      const data = await fetchJSON(API.search("*", page));

      // pp8 search responses vary, try common shapes
      const results =
        data.Results || data.results || data.Presentations || data.presentations || data.Items || data.items || [];

      if (!Array.isArray(results) || results.length === 0) {
        hasMore = false;
        break;
      }

      for (const r of results) {
        // Infer type from session type field if available
        const sessionType = (r.SessionType || r.sessionType || r.SessionTitle || r.sessionTitle || "").toLowerCase();
        const type = sessionType.includes("poster") ? "poster" : "talk";
        abstracts.push(normalizeAbstract(r, r, type));
      }

      console.log(`  Page ${page}: ${results.length} results (total: ${abstracts.length})`);

      // Check if there are more pages
      const totalPages = data.TotalPages || data.totalPages || data.PageCount || 999;
      if (page >= totalPages || results.length < 10) {
        hasMore = false;
      }

      page++;
      await delay(300);
    } catch (e) {
      console.log(`  Page ${page} failed: ${e.message}`);
      hasMore = false;
    }
  }

  if (abstracts.length === 0) {
    console.error("\n✗ Could not retrieve any abstracts.");
    console.log("\n── Manual alternative ──");
    console.log("1. Open https://www.abstractsonline.com/pp8/#!/21436/sessions");
    console.log("2. Open browser DevTools (F12) → Network tab");
    console.log("3. Look for XHR/Fetch requests to /api/ endpoints");
    console.log("4. Note the exact URL patterns and adapt this script");
    console.log("5. Or use the browser console scraper below:\n");
    printBrowserScraper();
    return;
  }

  writeOutput(abstracts);
}

/**
 * Normalize abstract data from various pp8 response shapes.
 * @param {object} detail  - Full detail response (or listing if detail unavailable)
 * @param {object} listing - Session listing entry (may have _sessionTitle, _type)
 * @param {string} type    - "poster" or "talk"
 */
function normalizeAbstract(detail, listing, type = "poster") {
  const get = (...keys) => {
    for (const k of keys) {
      const val = detail?.[k] ?? listing?.[k];
      if (val !== undefined && val !== null && val !== "") return val;
    }
    return "";
  };

  // Authors can be a string, array, or nested object
  let authors = get("Authors", "authors", "AuthorList", "authorList");
  if (typeof authors === "string") {
    authors = authors.split(/[;,]/).map((a) => a.trim()).filter(Boolean);
  } else if (Array.isArray(authors)) {
    authors = authors.map(
      (a) =>
        typeof a === "string"
          ? a.trim()
          : [a.FirstName || a.firstName || "", a.LastName || a.lastName || ""]
              .filter(Boolean)
              .join(" ")
    );
  } else {
    authors = [];
  }

  // Topics/keywords
  let topics = get("Keywords", "keywords", "Topics", "topics", "Categories", "categories");
  if (typeof topics === "string") {
    topics = topics.split(/[;,]/).map((t) => t.trim()).filter(Boolean);
  } else if (!Array.isArray(topics)) {
    topics = [];
  }

  return {
    id: String(
      get("AbstractNumber", "abstractNumber", "PresentationNumber", "presentationNumber", "Id", "id")
    ),
    type,
    title: get("Title", "title", "AbstractTitle", "abstractTitle"),
    authors,
    institution: get(
      "Institution", "institution", "Affiliation", "affiliation",
      "Institutions", "institutions"
    ),
    session: get("SessionTitle", "sessionTitle", "_sessionTitle"),
    cancerType: inferCancerType(
      get("Title", "title", "AbstractTitle", "abstractTitle") +
      " " + get("Abstract", "abstract", "Body", "body", "AbstractBody", "abstractBody")
    ),
    topics,
    posterNumber: get(
      "PosterNumber", "posterNumber", "BoardNumber", "boardNumber",
      "PresentationNumber", "presentationNumber"
    ),
    abstract: get("Abstract", "abstract", "Body", "body", "AbstractBody", "abstractBody"),
  };
}

/**
 * Infer cancer type from title/abstract text
 */
function inferCancerType(text) {
  const map = [
    [/breast/i, "Breast Cancer"],
    [/lung|nsclc|sclc/i, "Lung Cancer"],
    [/colorectal|colon|crc/i, "Colorectal Cancer"],
    [/pancrea/i, "Pancreatic Cancer"],
    [/melanoma/i, "Melanoma"],
    [/prostate/i, "Prostate Cancer"],
    [/ovarian/i, "Ovarian Cancer"],
    [/glioblastoma|gbm|glioma|brain/i, "Glioblastoma"],
    [/hepatocellular|liver|hcc/i, "Hepatocellular Carcinoma"],
    [/renal|kidney|rcc/i, "Renal Cell Carcinoma"],
    [/bladder|urothelial/i, "Bladder Cancer"],
    [/head.and.neck|hnscc|oral/i, "Head & Neck SCC"],
    [/leukemia|aml|cll|all\b/i, "Leukemia"],
    [/lymphoma|dlbcl/i, "Lymphoma"],
    [/gastric|stomach/i, "Gastric Cancer"],
    [/endometrial|uterine/i, "Endometrial Cancer"],
    [/thyroid/i, "Thyroid Cancer"],
    [/sarcoma/i, "Sarcoma"],
    [/myeloma/i, "Multiple Myeloma"],
  ];
  for (const [re, label] of map) {
    if (re.test(text)) return label;
  }
  return "Pan-Cancer / Other";
}

function writeOutput(abstracts) {
  const outPath = "aacr_abstracts.json";
  const posters = abstracts.filter((a) => a.type === "poster").length;
  const talks = abstracts.filter((a) => a.type === "talk").length;
  fs.writeFileSync(outPath, JSON.stringify(abstracts, null, 2));
  console.log(`\n✓ Saved ${abstracts.length} abstracts to ${outPath}`);
  console.log(`  ${posters} posters + ${talks} talks`);
  console.log(`  File size: ${(fs.statSync(outPath).size / 1024).toFixed(0)} KB`);
  console.log("\nNext step: run 'uv run precompute_embeddings.py' to regenerate embeddings.");
}

/**
 * Print a browser console scraper as a last resort
 */
function printBrowserScraper() {
  console.log(`
// ══════════════════════════════════════════════════════════
// BROWSER CONSOLE SCRAPER — paste this into DevTools console
// while on the abstractsonline.com sessions page
// ══════════════════════════════════════════════════════════

(async function scrapeAACR() {
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // Method 1: Try intercepting the Angular/Backbone data store
  const appData = window.__data || window.PP8?.data || window.app?.data;
  if (appData?.presentations) {
    const blob = new Blob([JSON.stringify(appData.presentations, null, 2)], {type: 'application/json'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'aacr_abstracts_raw.json';
    a.click();
    console.log('Downloaded from app data store!');
    return;
  }

  // Method 2: Scrape the DOM
  console.log('Scraping from DOM...');
  const results = [];

  // Get all abstract links on the current page
  function scrapePage() {
    const items = document.querySelectorAll('.result-item, .presentation-item, [class*="abstract"], .item-row, .search-result');
    items.forEach(item => {
      const titleEl = item.querySelector('a, .title, h3, h4, .presentation-title');
      const authEl = item.querySelector('.authors, .author-list, .presenter');
      const numEl = item.querySelector('.number, .abstract-number, .poster-number');
      if (titleEl) {
        results.push({
          id: numEl?.textContent?.trim() || '',
          title: titleEl.textContent?.trim() || '',
          authors: authEl?.textContent?.trim()?.split(/[;,]/).map(a => a.trim()) || [],
          link: titleEl.href || '',
          session: document.querySelector('.session-title, .category-header')?.textContent?.trim() || '',
        });
      }
    });
  }

  // Paginate
  let page = 1;
  while (true) {
    scrapePage();
    console.log(\`Page \${page}: \${results.length} total abstracts\`);

    const nextBtn = document.querySelector('.next-page, .pagination .next, [aria-label="Next"], a[title="Next"]');
    if (!nextBtn || nextBtn.disabled || nextBtn.classList.contains('disabled')) break;

    nextBtn.click();
    await sleep(2000);
    page++;
    if (page > 100) break; // Safety limit
  }

  // Now fetch detail for each abstract
  console.log(\`\\nFetching details for \${results.length} abstracts...\`);
  for (let i = 0; i < results.length; i++) {
    if (!results[i].link) continue;
    try {
      const resp = await fetch(results[i].link);
      const html = await resp.text();
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');
      const body = doc.querySelector('.abstract-body, .abstract-content, .abstract-text, #abstractBody');
      if (body) results[i].abstract = body.textContent.trim();
      const inst = doc.querySelector('.institution, .affiliation');
      if (inst) results[i].institution = inst.textContent.trim();
      if (i % 10 === 0) console.log(\`  \${i}/\${results.length}\`);
      await sleep(300);
    } catch(e) { console.log(\`  Error on #\${i}: \${e.message}\`); }
  }

  // Download
  const blob = new Blob([JSON.stringify(results, null, 2)], {type: 'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'aacr_abstracts.json';
  a.click();
  console.log(\`\\n✓ Downloaded \${results.length} abstracts!\`);
})();
`);
}

main().catch((e) => {
  console.error("Fatal error:", e.message);
  console.log("\nTry the browser console scraper instead:");
  printBrowserScraper();
});
