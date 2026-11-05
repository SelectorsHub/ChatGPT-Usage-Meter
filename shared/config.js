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
    chrome: "https://chromewebstore.google.com/detail/chatgpt-usage-meter/kfpajilghdinlikficodoffkbdmlbmab/reviews",
    edge: "https://microsoftedge.microsoft.com/addons/detail/chatgpt-usage-meter/ncppokankpoenlikfbbjdehjbgoppboe/",
    firefox: ""
  },
  // Landing pages; "" opens nothing. The uninstall page gets ?v=&b=&d= appended.
  INSTALL_URL: "https://www.selectorshub.com/chatgpt-usage-meter-installed/",
  UNINSTALL_URL: "https://www.selectorshub.com/chatgpt-usage-meter-uninstalled/",

  ORIGIN: "https://chatgpt.com",

  // ██ TEST BUILD SWITCH — must be false in the store build ██
  // true = the Rate us button shows at once and the rating card pops 3s after
  // load, then again every 60s after "Maybe later" (production: 2d / 3d / 2d).
  RATE_TEST: false,

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

  // label is a getter so it follows the browser language (see cumT below).
  WINDOWS: {
    "3h":   { get label() { return cumT("capWin3h"); },    ms: 3 * 3600e3 },
    "5h":   { get label() { return cumT("capWin5h"); },    ms: 5 * 3600e3 },
    "day":  { get label() { return cumT("capWinDay"); },   ms: 24 * 3600e3 },
    "week": { get label() { return cumT("capWinWeek"); },  ms: 7 * 86400e3 },
    "month":{ get label() { return cumT("capWinMonth"); }, ms: 30 * 86400e3 }
  }
};

// Tool descriptions are translated; names are product names and stay as is.
for (const t of CUM_CONFIG.TOOLS) {
  const key = "tool_" + t.icon.replace(/-/g, "_");
  Object.defineProperty(t, "desc", { get() { return cumT(key); }, enumerable: true });
}

// ---------------------------------------------------------------- i18n
// All UI text lives in _locales/<lang>/messages.json. chrome.i18n picks the
// language the user has set for the BROWSER (falls back to English), in every
// context: service worker, content script, popup and options page.

// Language choice. The extension follows the language the user picked in
// ChatGPT (Settings → General → Language). The content script reads it from
// chatgpt.com's <html lang> and saves the matching _locales folder name in
// storage as "uiLang"; every context then loads that messages.json. With no
// ChatGPT language known (or one we don't ship), chrome.i18n's browser
// language is used.
const CUM_LANGS = ["en", "zh_CN", "zh_TW", "ja", "ko", "es", "fr", "de", "pt_BR", "pt_PT", "ru", "it", "tr", "id", "vi", "hi"];
var __cumLang = null, __cumMsgs = null;

// "ja-JP" -> "ja", "zh-Hant-TW" -> "zh_TW", "pt-PT" -> "pt_PT", "ar" -> null
function cumNormLang(tag) {
  const t = String(tag || "").trim().toLowerCase().replace(/_/g, "-");
  if (!t) return null;
  const base = t.split("-")[0];
  if (base === "zh") return /-(tw|hk|mo|hant)\b/.test(t) ? "zh_TW" : "zh_CN";
  if (base === "pt") return /-pt\b/.test(t) ? "pt_PT" : "pt_BR";
  return CUM_LANGS.includes(base) ? base : null;
}

// Load (or clear, with a falsy lang) the messages for a language. Pages and
// the service worker read the file themselves; the content script asks the
// service worker, since chatgpt.com can't load extension files.
async function cumUseLang(lang) {
  if (!lang || !CUM_LANGS.includes(lang)) { __cumLang = null; __cumMsgs = null; return false; }
  if (lang === __cumLang && __cumMsgs) return true;
  let msgs = null;
  try {
    if (typeof location !== "undefined" && /^https?:/.test(location.protocol)) {
      msgs = await chrome.runtime.sendMessage({ type: "cumMessages", lang });
    } else {
      msgs = await (await fetch(chrome.runtime.getURL(`_locales/${lang}/messages.json`))).json();
    }
  } catch (_) {}
  if (!msgs || typeof msgs !== "object") return false;
  __cumLang = lang; __cumMsgs = msgs;
  return true;
}

// Popup / options / service worker: use the saved ChatGPT language, if any.
async function cumInitLang() {
  try { const { uiLang } = await chrome.storage.local.get("uiLang"); await cumUseLang(uiLang); } catch (_) {}
}

// feature id -> message key (names are translated, see _locales)
var CUM_FEATURE_KEYS = {
  deep_research: "featDeepResearch",
  image_gen: "featImageGen",
  image_generation: "featImageGen",
  file_upload: "featFileUploads",
  file_uploads: "featFileUploads",
  odyssey: "featAgent",
  agent: "featAgent",
  agent_mode: "featAgent",
  operator: "featAgent",
  sora: "featVideo",
  video_gen: "featVideo",
  voice: "featVoice",
  advanced_voice: "featVoice",
  canvas: "featCanvas",
  tasks: "featTasks",
  connector_search: "featConnectors",
  codex: "featCodex",
  code_review: "featCodeReview",
  research: "featResearch",
  reason: "thinking",
  reasoning: "thinking",
  paste_text_to_file: "featPasteToFile"
};

// Display name of a feature quota or extra limit, translated at render time
// (the snapshot may have been built in another language).
function cumFeatureName(x) {
  const key = CUM_FEATURE_KEYS[String((x && x.id) || "").toLowerCase()];
  return key ? cumT(key) : (x && x.name) || "";
}

// BCP-47 tag of the language in use, for dates and <html lang>.
function cumLangTag() {
  if (__cumLang) return __cumLang.replace("_", "-");
  try { return chrome.i18n.getUILanguage(); } catch (_) { return "en"; }
}

// cumT("nLeft", [7]) -> "7 left" / "残り 7"
function cumT(key, subs) {
  const list = subs == null ? [] : [].concat(subs).map(String);
  const e = __cumMsgs && __cumMsgs[key];
  if (e && typeof e.message === "string") {
    return e.message.replace(/\$(\$|\d)/g, (_, d) => (d === "$" ? "$" : list[+d - 1] != null ? list[+d - 1] : ""));
  }
  let m = "";
  try { m = chrome.i18n.getMessage(key, list.length ? list : undefined); } catch (_) {}
  return m || key;
}

// Like cumT, but substitutions may be DOM nodes: returns an array of strings
// and nodes in the right order for the language. cumTN("resetIn", <b>2h</b>)
function cumTN(key, ...parts) {
  const marks = parts.map((_, i) => "\u0001" + i + "\u0002");
  const s = cumT(key, marks);
  const out = [];
  const re = /\u0001(\d+)\u0002/g;
  let last = 0, m;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    out.push(parts[+m[1]]);
    last = re.lastIndex;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

// Lower-case a label for use mid-sentence ("Codex weekly"), except in
// languages where that breaks grammar (German capitalises nouns).
function cumLower(s) {
  return /^de/i.test(cumLangTag()) ? String(s) : String(s).toLowerCase();
}

// Pages (popup, options): fill [data-i18n] text and [data-i18n-title|aria|placeholder].
function cumI18nPage(root) {
  root = root || document;
  document.documentElement.lang = cumLangTag();
  const dir = cumT("@@bidi_dir");
  if (dir === "rtl") document.documentElement.dir = "rtl";
  for (const el of root.querySelectorAll("[data-i18n]")) el.textContent = cumT(el.getAttribute("data-i18n"));
  for (const el of root.querySelectorAll("[data-i18n-title]")) el.title = cumT(el.getAttribute("data-i18n-title"));
  for (const el of root.querySelectorAll("[data-i18n-aria]")) el.setAttribute("aria-label", cumT(el.getAttribute("data-i18n-aria")));
  for (const el of root.querySelectorAll("[data-i18n-placeholder]")) el.placeholder = cumT(el.getAttribute("data-i18n-placeholder"));
}

// ---- identity helpers (v1.0.5) -------------------------------------------
// Shared by the service worker and the content script. They answer "which
// ChatGPT account is this browsing context signed in to?", so usage, history,
// thresholds and message counts can be kept per account instead of in one
// global bucket (a private window may be signed in to a different account).

// Payload of a JWT, or null. Used only to read ids/expiry, never verified.
function cumJwtClaims(token) {
  try { return JSON.parse(atob(String(token).split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))); }
  catch (_) { return null; }
}

// Stable id of the signed-in user from the /api/auth/session JSON.
function cumUserId(j) {
  if (!j || typeof j !== "object") return null;
  const u = j.user || {};
  if (u.id) return String(u.id);
  const c = cumJwtClaims(j.accessToken) || {};
  const a = c["https://api.openai.com/auth"] || {};
  const v = a.chatgpt_user_id || a.user_id || c.sub;
  if (v) return String(v);
  return u.email ? String(u.email).toLowerCase() : null;
}

// What a tab reports about its own session (never the access token).
// null = signed out (no access token in the session).
function cumIdentity(j, cookieAccountId) {
  if (!j || typeof j !== "object" || !j.accessToken) return null;
  const c = cumJwtClaims(j.accessToken) || {};
  const a = c["https://api.openai.com/auth"] || {};
  return {
    userId: cumUserId(j),
    accountId: cookieAccountId || (j.account && j.account.id) || a.chatgpt_account_id || null,
    plan: (j.account && (j.account.planType || j.account.plan_type)) || null
  };
}

// Storage-key part for one account: the user AND the workspace (a person can
// have a personal and a Team workspace, each with its own limits). null when
// the user cannot be told apart.
function cumAcctKey(id) {
  if (!id || !id.userId) return null;
  return (String(id.userId) + "~" + String(id.accountId || "-")).replace(/[^A-Za-z0-9_.~-]/g, "_").slice(0, 160);
}

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
  if (ms <= 0) return cumT("durNow");
  const m = Math.floor(ms / 60000);
  if (m < 1) return cumT("durLt1");
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  if (d >= 1) return h ? cumT("durDH", [d, h]) : cumT("durD", [d]);
  if (h >= 1) return cumT("durHM", [h, String(mm).padStart(2, "0")]);
  return cumT("durM", [mm]);
}

function cumWindowLabel(sec, short) {
  if (!sec) return cumT(short ? "lblLimit" : "winUsage");
  if (sec === 18000) return cumT(short ? "win5hShort" : "win5h");
  if (sec === 10800) return cumT(short ? "win3hShort" : "win3h");
  if (sec === 86400) return cumT(short ? "winDayShort" : "winDay");
  if (sec === 604800) return cumT(short ? "winWeekShort" : "winWeek");
  if (sec >= 2419200 && sec <= 2678400) return cumT(short ? "winMonthShort" : "winMonth");
  if (sec % 86400 === 0) return cumT("winNDay", [sec / 86400]);
  if (sec % 3600 === 0) return cumT("winNHour", [sec / 3600]);
  return cumT("winNMin", [Math.round(sec / 60)]);
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
