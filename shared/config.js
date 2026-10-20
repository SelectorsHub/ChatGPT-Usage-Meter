// shared/config.js — constants used by every surface (background, content
// script, popup, options). Loaded via importScripts() in the service worker,
// listed first in the content_scripts "js" array, and via <script> in pages.
//
// Fill STORE_URLS once the listings exist; empty values simply hide the
// related links ("Rate us", install/uninstall pages).

var CUM_CONFIG = {
  NAME: "ChatGPT Usage Meter",
  UTM_SOURCE: "chatgpt-usage-meter",

  PRODUCT_URL: "https://selectorshub.com/chatgpt-usage-meter/",
  ALL_TOOLS_URL: "https://selectorshub.com/",
  AUTHOR_URL: "https://www.linkedin.com/in/creator-sanjaykumar/",

  // TODO(Sanjay): paste the store review URLs after publishing.
  STORE_URLS: {
    chrome: "",   // e.g. https://chromewebstore.google.com/detail/<id>/reviews
    edge: "",
    firefox: ""
  },
  // TODO(Sanjay): optional landing pages; leave "" to open nothing.
  INSTALL_URL: "",
  UNINSTALL_URL: "",

  ORIGIN: "https://chatgpt.com",

  TOOLS: [
    { icon: "screenshot-with-url", name: "Screenshot with URL", desc: "Screenshots with the URL bar",   url: "https://selectorshub.com/screenshot-with-url/" },
    { icon: "testcase-studio",     name: "TestCase Studio",     desc: "Record test steps as you go",    url: "https://selectorshub.com/testcase-studio/" },
    { icon: "check-my-links",      name: "Check My Links",      desc: "Find broken links in 1 click",   url: "https://selectorshub.com/checkmylinks/" },
    { icon: "page-load-timer",     name: "Page Load Timer",     desc: "Page load time, automatically",  url: "https://selectorshub.com/page-load-timer/" },
    { icon: "selectorshub",        name: "SelectorsHub",        desc: "XPath & Playwright locators",    url: "https://selectorshub.com/selectorshub/" },
    { icon: "cssviewer",           name: "CSSViewer",           desc: "See any element's CSS on hover", url: "https://chromewebstore.google.com/detail/cssviewer/plnialnlnbaodbmoedcppffmgfmmghbj" },
    { icon: "clearcache",          name: "ClearCache",          desc: "Clear cache in one click",       url: "https://chromewebstore.google.com/detail/clear-cache/epompmcepniobjioaagepjacapcoofof" },
    { icon: "auto-data-filler",    name: "Auto Data Filler",    desc: "Fill forms in one click",        url: "https://selectorshub.com/auto-data-filler/" },
    { icon: "modify-header",       name: "Modify Header",       desc: "Edit request & response headers", url: "https://selectorshub.com/modify-header/" },
    { icon: "anyformat",           name: "AnyFormat",           desc: "Save images in any format",      url: "https://www.selectorshub.com/anyformat/" },
    { icon: "bookmarks-finder",    name: "Bookmarks Finder",    desc: "Find any bookmark by typing",    url: "https://www.selectorshub.com/bookmarks-finder/" },
    { icon: "testing-daily",       name: "Testing Daily",       desc: "Daily testing news & updates",   url: "https://selectorshub.com/testing-daily/" }
  ],

  DEFAULT_SETTINGS: {
    pollMinutes: 1,
    notify: true,
    thresholds: [75, 90, 100],
    badge: true,
    strip: true,
    collapsed: false,
    fields: {
      thinking: true,       // limits_progress "reason" — Thinking messages left
      primary: true,        // 5-hour window
      secondary: true,      // weekly window
      resetPrimary: true,
      resetSecondary: true,
      extraLimits: true,    // additional_rate_limits (per-feature windows)
      features: true,       // limits_progress (deep research, images…)
      credits: true,
      forecast: true,
      bars: true,
      chatTokens: true,
      modelCaps: true       // user-defined per-model caps
    },
    // User-defined caps, counted locally from messages sent in this browser.
    // [{ model: "gpt-6-pro", limit: 200, window: "week" }]
    modelCaps: []
  },

  WINDOWS: {
    "3h":   { label: "3 hours",  ms: 3 * 3600e3 },
    "5h":   { label: "5 hours",  ms: 5 * 3600e3 },
    "day":  { label: "24 hours", ms: 24 * 3600e3 },
    "week": { label: "7 days",   ms: 7 * 86400e3 },
    "month":{ label: "30 days",  ms: 30 * 86400e3 }
  }
};

function cumUtm(url, medium, campaign) {
  if (!url) return url;
  const sep = url.indexOf("?") === -1 ? "?" : "&";
  return url + sep + "utm_source=" + CUM_CONFIG.UTM_SOURCE +
    "&utm_medium=" + encodeURIComponent(medium) +
    "&utm_campaign=" + encodeURIComponent(campaign || "more-tools");
}

function cumStoreUrl() {
  const ua = (typeof navigator !== "undefined" && navigator.userAgent) || "";
  const s = CUM_CONFIG.STORE_URLS;
  if (/Firefox\//.test(ua)) return s.firefox || "";
  if (/Edg\//.test(ua)) return s.edge || s.chrome || "";
  return s.chrome || "";
}

// "2h 05m", "4d 3h", "12m", "<1m"
function cumFmtDuration(ms) {
  if (ms == null || !isFinite(ms)) return "";
  if (ms <= 0) return "now";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  if (d >= 1) return h ? `${d}d ${h}h` : `${d}d`;
  if (h >= 1) return `${h}h ${String(mm).padStart(2, "0")}m`;
  return `${mm}m`;
}

function cumWindowLabel(sec, short) {
  if (!sec) return short ? "Limit" : "Usage";
  if (sec === 18000) return short ? "5h" : "5-hour";
  if (sec === 10800) return short ? "3h" : "3-hour";
  if (sec === 86400) return short ? "Day" : "Daily";
  if (sec === 604800) return short ? "Week" : "Weekly";
  if (sec >= 2419200 && sec <= 2678400) return short ? "Month" : "Monthly";
  if (sec % 86400 === 0) return `${sec / 86400}-day`;
  if (sec % 3600 === 0) return `${sec / 3600}-hour`;
  return `${Math.round(sec / 60)}-min`;
}

function cumLevel(pct) {
  if (pct == null) return "none";
  if (pct >= 90) return "red";
  if (pct >= 75) return "orange";
  if (pct >= 50) return "amber";
  return "green";
}

function cumFmtTokens(n) {
  if (n == null) return "—";
  if (n < 1000) return String(n);
  if (n < 100000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "K";
  if (n < 1e6) return Math.round(n / 1000) + "K";
  return (n / 1e6).toFixed(2).replace(/0$/, "") + "M";
}

// Model slug match for user-defined caps. "gpt-6-pro" matches exactly;
// "gpt-5*" matches any slug starting with "gpt-5".
function cumModelMatches(pattern, model) {
  if (!pattern || !model) return false;
  pattern = String(pattern).trim().toLowerCase();
  model = String(model).toLowerCase();
  if (pattern.endsWith("*")) return model.startsWith(pattern.slice(0, -1));
  return model === pattern;
}

// For each user-defined cap: how many messages in its rolling window, and
// when the oldest one in the window rolls off (= next freed slot).
function cumCapUsage(log, caps, now) {
  now = now || Date.now();
  const out = [];
  for (const cap of caps || []) {
    if (!cap || !cap.model || !(cap.limit > 0)) continue;
    const win = CUM_CONFIG.WINDOWS[cap.window] || CUM_CONFIG.WINDOWS.day;
    const hits = (log || []).filter((e) => now - e.t <= win.ms && cumModelMatches(cap.model, e.m));
    const oldest = hits.length ? Math.min(...hits.map((e) => e.t)) : null;
    out.push({ cap, limit: Number(cap.limit), used: hits.length, freesAt: oldest ? oldest + win.ms : null });
  }
  return out;
}

// Messages per model in the last `ms`, most-used first.
function cumModelCounts(log, ms, now) {
  now = now || Date.now();
  const m = new Map();
  for (const e of log || []) if (now - e.t <= ms) m.set(e.m, (m.get(e.m) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}
